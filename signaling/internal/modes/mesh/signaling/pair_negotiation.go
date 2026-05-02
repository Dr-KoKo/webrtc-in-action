// pair_negotiation — §§3.9, 3.10, 3.11.
//
// Three concerns:
//   - Pair eligibility evaluation (T045 / §3.9): when a participant
//     transitions to `media-ready`, register every NEW pair with
//     already-`media-ready` peers and emit
//     `pair_negotiation_instruction` to each endpoint.
//   - Offer relay (§3.10): handlePairOffer + relayPair.
//   - Answer relay (§3.11): handlePairAnswer + relayPair.

package signaling

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"webrtc-lab/signaling/internal/modes/mesh/protocol"
	"webrtc-lab/signaling/internal/modes/mesh/room"
)

// pairInstruction is one (pairId, role, recipient, remote) tuple
// derived from the room's post-transition state. Collected while
// holding the room lock and emitted after release so the outbound
// fan-out never races a concurrent admission.
type pairInstruction struct {
	pairID    string
	pairEpoch uint64
	role      protocol.PairRole
	recipient *room.Participant
	remote    *room.Participant
}

// evaluateAndEmitInstructions runs the §3.9 evaluator for the
// supplied `subject` (just-transitioned participant) inside `rm`.
// Returns the number of pair_negotiation_instruction envelopes
// emitted. Caller must NOT hold the room lock.
//
// Existing-pair stability (FR-022a / L18): only NEW pairs receive
// instructions. Any pair already in the ledger — `Pairing`,
// `Connected`, or otherwise — is left untouched.
//
// Offerer rule (§3.9): the participant with the lower
// `admissionIndex` of the pair is the offerer.
func (s *Service) evaluateAndEmitInstructions(rm *room.Room, subject *room.Participant) int {
	if rm == nil || subject == nil {
		return 0
	}
	rm.Lock()
	current := rm.FindByPeerID(subject.PeerID)
	if current == nil || current.Readiness != room.ReadinessMediaReady {
		rm.Unlock()
		return 0
	}
	ledger := rm.PairLedger()
	if ledger == nil {
		rm.Unlock()
		return 0
	}
	parts := rm.ParticipantsSnapshot()
	iceServers := s.ICE

	instructions := make([]pairInstruction, 0, 2*(len(parts)-1))
	for _, peer := range parts {
		if peer.PeerID == current.PeerID {
			continue
		}
		if peer.Readiness != room.ReadinessMediaReady {
			continue
		}
		var loIdx, hiIdx uint64
		var loPeer, hiPeer *room.Participant
		if current.AdmissionIndex < peer.AdmissionIndex {
			loIdx, hiIdx = current.AdmissionIndex, peer.AdmissionIndex
			loPeer, hiPeer = current, peer
		} else {
			loIdx, hiIdx = peer.AdmissionIndex, current.AdmissionIndex
			loPeer, hiPeer = peer, current
		}
		pairID := protocol.MakePairID(loIdx, hiIdx)
		if _, exists := ledger.Lookup(pairID); exists {
			continue
		}
		pair, epoch := ledger.Register(pairID, loPeer.PeerID, hiPeer.PeerID)
		pair.State = room.PairPairing
		instructions = append(instructions,
			pairInstruction{
				pairID:    pairID,
				pairEpoch: epoch,
				role:      protocol.RoleOfferer,
				recipient: loPeer,
				remote:    hiPeer,
			},
			pairInstruction{
				pairID:    pairID,
				pairEpoch: epoch,
				role:      protocol.RoleAnswerer,
				recipient: hiPeer,
				remote:    loPeer,
			},
		)
	}
	roomID := rm.ID()
	rm.Unlock()

	for _, ins := range instructions {
		payload, _ := json.Marshal(protocol.PairNegotiationInstructionPayload{
			PairIdentity: protocol.PairIdentity{
				PairID:    ins.pairID,
				PairEpoch: ins.pairEpoch,
			},
			Role: ins.role,
			RemotePeer: protocol.RemotePeerRef{
				PeerID:         ins.remote.PeerID,
				AdmissionIndex: ins.remote.AdmissionIndex,
			},
			IceServers: iceServers,
		})
		env := protocol.Envelope{
			V:       protocol.ContractVersion,
			Type:    protocol.TypePairNegotiationInstruction,
			RoomID:  roomID,
			To:      ins.recipient.PeerID,
			TS:      time.Now().UnixMilli(),
			Payload: payload,
		}
		if ins.recipient.Conn == nil {
			continue
		}
		if err := ins.recipient.Conn.SendJSON(ins.recipient.Conn.BaseContext(), env); err != nil {
			s.Log.Warn("pair_negotiation_instruction send failed",
				slog.String("event", "mesh_pair_instruction_send_failed"),
				slog.String("peer_id", ins.recipient.PeerID),
				slog.String("pair_id", ins.pairID),
				slog.String("role", string(ins.role)),
				slog.String("error", err.Error()),
			)
			continue
		}
		s.Log.Info("pair_negotiation_instruction emitted",
			slog.String("event", "mesh_pair_instruction_emitted"),
			slog.String("room_id", roomID),
			slog.String("pair_id", ins.pairID),
			slog.Uint64("pair_epoch", ins.pairEpoch),
			slog.String("role", string(ins.role)),
			slog.String("to", ins.recipient.PeerID),
		)
	}
	return len(instructions)
}

// pairRelayKind discriminates offer-vs-answer at the relay level so
// the same plumbing covers both message types.
type pairRelayKind int

const (
	relayKindOffer pairRelayKind = iota
	relayKindAnswer
)

// handlePairOffer implements the §3.10 server-side relay path.
func (s *Service) handlePairOffer(ctx context.Context, conn Conn, d *protocol.Decoded) error {
	payload, ok := d.Message.(*protocol.PairOfferPayload)
	if !ok || payload == nil {
		s.writeError(ctx, conn, &protocol.ProtocolError{
			Code:    protocol.CodeInternalError,
			Message: "pair_offer decode mismatch",
		}, d.Envelope.RequestID)
		return nil
	}
	return s.relayPair(ctx, conn, d, relayKindOffer, payload.PairID, payload.PairEpoch, payload.SDP.Type, d.Envelope.Payload)
}

// handlePairAnswer implements the §3.11 server-side relay path.
func (s *Service) handlePairAnswer(ctx context.Context, conn Conn, d *protocol.Decoded) error {
	payload, ok := d.Message.(*protocol.PairAnswerPayload)
	if !ok || payload == nil {
		s.writeError(ctx, conn, &protocol.ProtocolError{
			Code:    protocol.CodeInternalError,
			Message: "pair_answer decode mismatch",
		}, d.Envelope.RequestID)
		return nil
	}
	return s.relayPair(ctx, conn, d, relayKindAnswer, payload.PairID, payload.PairEpoch, payload.SDP.Type, d.Envelope.Payload)
}

// relayPair is the shared validate + forward path for pair_offer /
// pair_answer. The decoded payload bytes are forwarded as-is (the
// server never parses sdp).
func (s *Service) relayPair(
	ctx context.Context,
	conn Conn,
	d *protocol.Decoded,
	kind pairRelayKind,
	pairID string,
	pairEpoch uint64,
	sdpType string,
	rawPayload json.RawMessage,
) error {
	state := conn.State()
	if state.PeerID == "" || state.RoomID == "" {
		s.writeError(ctx, conn, &protocol.ProtocolError{
			Code:    protocol.CodeNotInRoom,
			Message: "pair message requires an admitted participant",
		}, d.Envelope.RequestID)
		return nil
	}
	rm := s.Rooms.Room(state.RoomID)
	if rm == nil {
		s.writeError(ctx, conn, &protocol.ProtocolError{
			Code:    protocol.CodeNotInRoom,
			Message: "mesh room not found",
		}, d.Envelope.RequestID)
		return nil
	}

	rm.Lock()
	ledger := rm.PairLedger()
	if ledger == nil {
		rm.Unlock()
		s.writeError(ctx, conn, &protocol.ProtocolError{
			Code:    protocol.CodeInternalError,
			Message: "pair ledger unavailable",
		}, d.Envelope.RequestID)
		return nil
	}
	pair, exists := ledger.Lookup(pairID)
	if !exists {
		rm.Unlock()
		s.writeError(ctx, conn, &protocol.ProtocolError{
			Code:    protocol.CodeStalePairEpoch,
			Message: "pair " + pairID + " is unknown to the server",
		}, d.Envelope.RequestID)
		return nil
	}
	senderIsLo := pair.LoPeerID == state.PeerID
	senderIsHi := pair.HiPeerID == state.PeerID
	if !senderIsLo && !senderIsHi {
		rm.Unlock()
		s.writeError(ctx, conn, wrongRoleError(kind, "sender does not belong to pair "+pairID), d.Envelope.RequestID)
		return nil
	}
	switch kind {
	case relayKindOffer:
		if !senderIsLo {
			rm.Unlock()
			s.writeError(ctx, conn, &protocol.ProtocolError{
				Code:    protocol.CodeUnexpectedOffer,
				Message: "pair_offer must come from the offerer (lower admissionIndex)",
			}, d.Envelope.RequestID)
			return nil
		}
		if sdpType != "offer" {
			rm.Unlock()
			s.writeError(ctx, conn, &protocol.ProtocolError{
				Code:    protocol.CodeMalformed,
				Message: "pair_offer.sdp.type must be 'offer'",
			}, d.Envelope.RequestID)
			return nil
		}
	case relayKindAnswer:
		if !senderIsHi {
			rm.Unlock()
			s.writeError(ctx, conn, &protocol.ProtocolError{
				Code:    protocol.CodeUnexpectedAnswer,
				Message: "pair_answer must come from the answerer (higher admissionIndex)",
			}, d.Envelope.RequestID)
			return nil
		}
		if sdpType != "answer" {
			rm.Unlock()
			s.writeError(ctx, conn, &protocol.ProtocolError{
				Code:    protocol.CodeMalformed,
				Message: "pair_answer.sdp.type must be 'answer'",
			}, d.Envelope.RequestID)
			return nil
		}
	}
	if perr := protocol.ValidateStalePairEpoch(pairID, pairEpoch, ledger); perr != nil {
		rm.Unlock()
		s.writeError(ctx, conn, perr, d.Envelope.RequestID)
		return nil
	}
	var recipientPeerID string
	if senderIsLo {
		recipientPeerID = pair.HiPeerID
	} else {
		recipientPeerID = pair.LoPeerID
	}
	recipient := rm.FindByPeerID(recipientPeerID)
	roomID := rm.ID()
	rm.Unlock()

	if recipient == nil || recipient.Conn == nil {
		s.Log.Info("pair relay recipient absent",
			slog.String("event", "mesh_pair_relay_recipient_absent"),
			slog.String("room_id", roomID),
			slog.String("pair_id", pairID),
			slog.String("kind", relayKindLabel(kind)),
		)
		return nil
	}

	envOut := protocol.Envelope{
		V:       protocol.ContractVersion,
		Type:    pairRelayType(kind),
		RoomID:  roomID,
		From:    state.PeerID,
		To:      recipientPeerID,
		TS:      time.Now().UnixMilli(),
		Payload: rawPayload,
	}
	if err := recipient.Conn.SendJSON(recipient.Conn.BaseContext(), envOut); err != nil {
		s.Log.Warn("pair relay forward failed",
			slog.String("event", "mesh_pair_relay_send_failed"),
			slog.String("kind", relayKindLabel(kind)),
			slog.String("pair_id", pairID),
			slog.String("to", recipientPeerID),
			slog.String("error", err.Error()),
		)
		return nil
	}
	s.Log.Info("pair relay forwarded",
		slog.String("event", "mesh_pair_relay_forwarded"),
		slog.String("room_id", roomID),
		slog.String("pair_id", pairID),
		slog.Uint64("pair_epoch", pairEpoch),
		slog.String("kind", relayKindLabel(kind)),
		slog.String("from", state.PeerID),
		slog.String("to", recipientPeerID),
	)
	return nil
}

func pairRelayType(k pairRelayKind) protocol.MessageType {
	if k == relayKindAnswer {
		return protocol.TypePairAnswer
	}
	return protocol.TypePairOffer
}

func relayKindLabel(k pairRelayKind) string {
	if k == relayKindAnswer {
		return "pair_answer"
	}
	return "pair_offer"
}

func wrongRoleError(k pairRelayKind, msg string) *protocol.ProtocolError {
	if k == relayKindAnswer {
		return &protocol.ProtocolError{Code: protocol.CodeUnexpectedAnswer, Message: msg}
	}
	return &protocol.ProtocolError{Code: protocol.CodeUnexpectedOffer, Message: msg}
}
