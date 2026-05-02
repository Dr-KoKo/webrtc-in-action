package signaling

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"webrtc-lab/signaling/internal/modes/onetoone/protocol"
	"webrtc-lab/signaling/internal/modes/onetoone/room"
)

// handleMediaReady transitions the sender's mediaReadiness
// pending-media → ready, broadcasts peer_presence_changed(ready,
// media_ready), and — if the room reaches paired call-readiness —
// assigns roles by admissionOrder and emits ready_for_offer to both
// peers exactly once per pairing attempt (contract §§3.5, 3.7).
func (s *Service) handleMediaReady(ctx context.Context, conn Conn, d *protocol.Decoded) error {
	state := conn.State()
	if state.PeerID == "" {
		s.writeError(ctx, conn, &protocol.DecodeError{
			Code:    protocol.CodeNotInRoom,
			Message: "media_ready requires an admitted participant",
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
	if p.MediaReadiness != room.MediaReadinessPending {
		rm.Unlock()
		s.writeError(ctx, conn, &protocol.DecodeError{
			Code:    protocol.CodeUnexpectedMediaReady,
			Message: "media_ready requires mediaReadiness = pending-media",
		}, d.Envelope.RequestID)
		return nil
	}

	p.MediaReadiness = room.MediaReadinessReady

	// Capture everything we need for post-unlock work.
	assignRoles := rm.CallReadiness() == room.CallReadinessPaired && !rm.RolesAssigned()
	var pairParticipants []*room.Participant
	if assignRoles {
		pairParticipants = rm.Participants()
		for _, pp := range pairParticipants {
			pp.CallPhase = room.CallPhaseRoleAssigned
		}
		rm.SetRolesAssigned(true)
	}
	rm.Unlock()

	s.broadcastPresence(rm, p, protocol.PresenceReady, protocol.PresenceReasonMediaReady)

	if assignRoles {
		s.sendReadyForOffer(rm, pairParticipants)
	}

	s.Log.Info("media ready",
		slog.String("event", "media_ready"),
		slog.String("conn_id", conn.ID()),
		slog.String("peer_id", state.PeerID),
		slog.String("room_id", state.RoomID),
		slog.Bool("roles_assigned", assignRoles),
	)
	return nil
}

// handleMediaFailed releases the sender's slot, notifies the sender
// with `participant_released`, notifies any remaining peer via
// `peer_presence_changed(released, media_failed)`, and clears the
// connCtx's room / peer association so the same WebSocket MAY send
// another `join_room` (contract §§3.6, 3.13 "Server-side retry
// support"). No `peer_left` is emitted — pending-media releases are
// pre-pairing by definition.
func (s *Service) handleMediaFailed(ctx context.Context, conn Conn, d *protocol.Decoded) error {
	state := conn.State()
	if state.PeerID == "" {
		s.writeError(ctx, conn, &protocol.DecodeError{
			Code:    protocol.CodeNotInRoom,
			Message: "media_failed requires an admitted participant",
		}, d.Envelope.RequestID)
		return nil
	}
	payload, _ := d.Message.(*protocol.MediaFailedPayload)

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
	if p.MediaReadiness != room.MediaReadinessPending {
		rm.Unlock()
		s.writeError(ctx, conn, &protocol.DecodeError{
			Code:    protocol.CodeMalformed,
			Message: "media_failed requires mediaReadiness = pending-media",
		}, d.Envelope.RequestID)
		return nil
	}
	rm.Unlock()

	// Send participant_released to the failed peer BEFORE releasing —
	// the WS is still open and reachable.
	detail := ""
	if payload != nil {
		detail = string(payload.Reason)
	}
	relPayload, _ := json.Marshal(protocol.ParticipantReleasedPayload{
		Result: protocol.ParticipantReleasedMediaFailed,
		Reason: protocol.ReleasedReasonMediaFailed,
		Detail: detail,
	})
	relEnv := protocol.Envelope{
		V:       protocol.ContractVersion,
		Type:    protocol.TypeParticipantReleased,
		RoomID:  state.RoomID,
		TS:      time.Now().UnixMilli(),
		Payload: relPayload,
	}
	if err := conn.SendJSON(ctx, relEnv); err != nil {
		s.Log.Warn("participant_released send failed",
			slog.String("conn_id", conn.ID()),
			slog.String("error", err.Error()))
	}

	// Release the slot and notify any remaining peer. The in-call
	// classification inside releaseAndNotify will correctly pick
	// presence=released (pending-media implies !inCall).
	s.releaseAndNotify(conn, "media_failed")

	// Clear association so the SAME WS can send join_room again
	// without hitting already_joined. ServeHTTP's deferred cleanup now
	// short-circuits on State().PeerID == "" and will not double-release.
	// Reset the release latch so a future rejoin's disconnect still
	// triggers the cleanup path for the NEW slot.
	conn.ClearJoined()
	conn.ResetReleaseLatch()

	s.Log.Info("media failed",
		slog.String("event", "media_failed"),
		slog.String("conn_id", conn.ID()),
		slog.String("reason", detail),
	)
	return nil
}

// handleMediaState validates the sender's state per contract §3.11
// (mediaReadiness == ready; callPhase ∈ {role-assigned, negotiating,
// connected}) via room.CanSendMediaState and relays the payload bytes
// verbatim to the remote peer only. envelope.from is stamped with the
// sender's peerID. The server MUST NOT log the mic / camera /
// screenShare values themselves — only the sender / receiver peer IDs.
//
// Full-triplet validation (microphone, camera, screenShare all
// required) is enforced at decode time by protocol.MediaStatePayload.Validate():
// a missing field decodes to "" which fails the enum switch.
func (s *Service) handleMediaState(ctx context.Context, conn Conn, d *protocol.Decoded) error {
	state := conn.State()
	if state.PeerID == "" {
		s.writeError(ctx, conn, &protocol.DecodeError{
			Code:    protocol.CodeNotInRoom,
			Message: "media_state requires an admitted participant",
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
	if relayErr := p.CanSendMediaState(role); relayErr != nil {
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
		s.writeError(ctx, conn, &protocol.DecodeError{
			Code:    protocol.CodeNotInRoom,
			Message: "remote peer not present",
		}, d.Envelope.RequestID)
		return nil
	}
	remoteConn := remote.Conn
	remotePeerID := remote.PeerID
	rm.Unlock()

	// Relay payload bytes verbatim — the server never needs to parse
	// the on/off values to route the message. Only envelope metadata
	// is rewritten.
	outEnv := protocol.Envelope{
		V:       protocol.ContractVersion,
		Type:    protocol.TypeMediaState,
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
		s.Log.Warn("media_state relay failed",
			slog.String("peer_id", remotePeerID),
			slog.String("error", err.Error()))
		return nil
	}

	// Structured log — peer IDs only. MUST NOT log microphone / camera
	// / screenShare values (contract §3.11 confidentiality; on/off
	// state is user-observable signal, not server telemetry).
	s.Log.Info("media_state relayed",
		slog.String("event", "media_state_relay"),
		slog.String("from_peer_id", state.PeerID),
		slog.String("to_peer_id", remotePeerID),
	)
	return nil
}
