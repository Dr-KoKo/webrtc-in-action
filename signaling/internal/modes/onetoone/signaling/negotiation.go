package signaling

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"webrtc-lab/signaling/internal/modes/onetoone/protocol"
	"webrtc-lab/signaling/internal/modes/onetoone/room"
)

// sendReadyForOffer emits exactly one ready_for_offer per peer in the
// supplied pairing, using the lower `admissionOrder` as offerer
// (contract §§3.7, §C.1). Callers MUST have already flipped
// rm.SetRolesAssigned(true) and advanced both participants'
// CallPhase to role-assigned under the room lock.
func (s *Service) sendReadyForOffer(rm *room.Room, participants []*room.Participant) {
	if len(participants) != room.MaxParticipants {
		return
	}
	offerer, answerer := participants[0], participants[1]
	if answerer.AdmissionOrder < offerer.AdmissionOrder {
		offerer, answerer = answerer, offerer
	}

	send := func(self, remote *room.Participant, role protocol.Role) {
		payload, _ := json.Marshal(protocol.ReadyForOfferPayload{
			Role: role,
			RemotePeer: protocol.ReadyForOfferRemote{
				PeerID:         remote.PeerID,
				AdmissionOrder: remote.AdmissionOrder,
			},
			IceServers: s.ICE,
		})
		env := protocol.Envelope{
			V:       protocol.ContractVersion,
			Type:    protocol.TypeReadyForOffer,
			RoomID:  rm.ID(),
			To:      self.PeerID,
			TS:      time.Now().UnixMilli(),
			Payload: payload,
		}
		if self.Conn == nil {
			return
		}
		if err := self.Conn.SendJSON(self.Conn.BaseContext(), env); err != nil {
			s.Log.Warn("ready_for_offer send failed",
				slog.String("peer_id", self.PeerID),
				slog.String("error", err.Error()))
		}
	}

	send(offerer, answerer, protocol.RoleOfferer)
	send(answerer, offerer, protocol.RoleAnswerer)

	// Structured log — role + admissionOrder only; MUST NOT log
	// iceServers (TURN credential confidentiality per §3.7).
	s.Log.Info("ready_for_offer sent",
		slog.String("event", "ready_for_offer"),
		slog.String("room_id", rm.ID()),
		slog.String("offerer_peer_id", offerer.PeerID),
		slog.String("answerer_peer_id", answerer.PeerID),
	)
}

// handleOffer validates an offer against the sender's assigned role
// and state (mediaReadiness × callPhase), relays it to the remote
// peer with envelope.from = sender peerId, and advances the sender's
// CallPhase role-assigned → negotiating (§§3.8, C.2).
func (s *Service) handleOffer(ctx context.Context, conn Conn, d *protocol.Decoded) error {
	return s.handleSDPRelay(ctx, conn, d, protocol.TypeOffer)
}

// handleAnswer mirrors handleOffer for §3.9.
func (s *Service) handleAnswer(ctx context.Context, conn Conn, d *protocol.Decoded) error {
	return s.handleSDPRelay(ctx, conn, d, protocol.TypeAnswer)
}

// handleSDPRelay is the shared offer / answer pathway. Keeps the
// three-field truth table (role × mediaReadiness × callPhase)
// centralized behind room.CanSendOffer / CanSendAnswer so offer and
// answer cannot drift apart.
//
// Importantly, the server NEVER parses payload.sdp.sdp — the inbound
// payload bytes are forwarded verbatim on the new envelope with only
// envelope.from / envelope.to / envelope.ts overwritten. NFR-003.
func (s *Service) handleSDPRelay(ctx context.Context, conn Conn, d *protocol.Decoded, t protocol.Type) error {
	state := conn.State()
	if state.PeerID == "" {
		s.writeError(ctx, conn, &protocol.DecodeError{
			Code:    protocol.CodeNotInRoom,
			Message: string(t) + " requires an admitted participant",
		}, d.Envelope.RequestID)
		return nil
	}
	rm := s.Rooms.Room(state.RoomID)
	if rm == nil {
		s.writeError(ctx, conn, &protocol.DecodeError{
			Code:    protocol.CodeNotInRoom,
			Message: "room not found",
		}, d.Envelope.RequestID)
		return nil
	}

	rm.Lock()
	p := rm.FindByPeerID(state.PeerID)
	if p == nil {
		rm.Unlock()
		s.writeError(ctx, conn, &protocol.DecodeError{
			Code:    protocol.CodeNotInRoom,
			Message: "participant not found",
		}, d.Envelope.RequestID)
		return nil
	}

	role := rm.AssignedRole(state.PeerID)
	var relayErr *room.RelayError
	switch t {
	case protocol.TypeOffer:
		relayErr = p.CanSendOffer(role)
	case protocol.TypeAnswer:
		relayErr = p.CanSendAnswer(role)
	}
	if relayErr != nil {
		rm.Unlock()
		s.writeError(ctx, conn, &protocol.DecodeError{
			Code:    protocol.ErrorCode(relayErr.Code),
			Message: relayErr.Message,
		}, d.Envelope.RequestID)
		return nil
	}

	remote := rm.ResolveRemote(state.PeerID)
	if remote == nil {
		rm.Unlock()
		// Contract: remote-peer unresolvable is a transient protocol
		// failure — the remote may have just disconnected. Surface as
		// not_in_room to the sender.
		s.writeError(ctx, conn, &protocol.DecodeError{
			Code:    protocol.CodeNotInRoom,
			Message: "remote peer not present",
		}, d.Envelope.RequestID)
		return nil
	}

	// Advance sender's CallPhase through role-assigned → negotiating
	// on the first accepted offer / answer for this pairing (§3.8,
	// §3.9). Subsequent relays are no-ops at the phase layer (the
	// duplicate-offer guard lives in CanSendOffer).
	if p.CallPhase == room.CallPhaseRoleAssigned {
		p.CallPhase = room.CallPhaseNegotiating
	}

	remoteConn := remote.Conn
	remotePeerID := remote.PeerID
	rm.Unlock()

	// Relay payload bytes verbatim. Only envelope metadata is
	// rewritten — per NFR-003 the server does not parse SDP content.
	outEnv := protocol.Envelope{
		V:       protocol.ContractVersion,
		Type:    t,
		RoomID:  state.RoomID,
		From:    state.PeerID,
		To:      remotePeerID,
		TS:      time.Now().UnixMilli(),
		Payload: d.Envelope.Payload,
	}
	if remoteConn == nil {
		s.writeError(ctx, conn, &protocol.DecodeError{
			Code:    protocol.CodeNotInRoom,
			Message: "remote peer not present",
		}, d.Envelope.RequestID)
		return nil
	}
	if err := remoteConn.SendJSON(remoteConn.BaseContext(), outEnv); err != nil {
		// Write failed — structured observability must NOT claim
		// success. We surface the failure to the sender as
		// `internal_error` (the best generic code for "your message
		// could not be delivered to the remote peer"), log the
		// failure, and stop without emitting the success line.
		s.Log.Warn("sdp relay failed",
			slog.String("type", string(t)),
			slog.String("peer_id", remotePeerID),
			slog.String("error", err.Error()))
		s.writeError(ctx, conn, &protocol.DecodeError{
			Code:    protocol.CodeInternalError,
			Message: "remote peer unreachable",
		}, d.Envelope.RequestID)
		return nil
	}

	s.Log.Info("sdp relayed",
		slog.String("event", "sdp_relay"),
		slog.String("type", string(t)),
		slog.String("from_peer_id", state.PeerID),
		slog.String("to_peer_id", remotePeerID),
	)
	return nil
}
