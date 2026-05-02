// Server-side fan-out for `pair_media_state` (M9 / T071, contract
// §3.13).
//
// Semantics — `pair_media_state` is participant-level metadata, NOT
// a pairwise connection-attempt message. The server validates the
// sender, then fans the same payload bytes out to every OTHER
// admitted participant in the room with `from = sender.peerId`. No
// pairId / pairEpoch checks (§3.13 note: this message carries
// neither). Server constraints (NFR-003 + plan-prompt):
//
//   - Never relay any media payload (the payload here is metadata only).
//   - Never mutate the payload bytes.
//   - Never log mic/cam/screen values — counts + correlation only.
//   - Never send the envelope back to the sender.

package signaling

import (
	"context"
	"log/slog"
	"time"

	"webrtc-lab/signaling/internal/modes/mesh/protocol"
	"webrtc-lab/signaling/internal/modes/mesh/room"
)

// handlePairMediaState — §3.13 server-fan-out.
func (s *Service) handlePairMediaState(ctx context.Context, conn Conn, d *protocol.Decoded) error {
	state := conn.State()
	if state.PeerID == "" || state.RoomID == "" {
		s.writeError(ctx, conn, &protocol.ProtocolError{
			Code:    protocol.CodeNotInRoom,
			Message: "pair_media_state requires an admitted participant",
		}, d.Envelope.RequestID)
		return nil
	}
	if _, ok := d.Message.(*protocol.PairMediaStatePayload); !ok {
		s.writeError(ctx, conn, &protocol.ProtocolError{
			Code:    protocol.CodeInternalError,
			Message: "pair_media_state decode mismatch",
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
	subject := rm.FindByPeerID(state.PeerID)
	if subject == nil {
		rm.Unlock()
		s.writeError(ctx, conn, &protocol.ProtocolError{
			Code:    protocol.CodeNotInRoom,
			Message: "participant not found in room",
		}, d.Envelope.RequestID)
		return nil
	}
	// §3.13 server validation: a `released` or `left` sender (or one
	// still in `joined` pre-media-acquisition) must not leak
	// media-state to the room. media-ready is the only readiness
	// that may publish.
	if subject.Readiness != room.ReadinessMediaReady {
		rm.Unlock()
		s.writeError(ctx, conn, &protocol.ProtocolError{
			Code:    protocol.CodeNotInRoom,
			Message: "pair_media_state requires readiness=media-ready",
		}, d.Envelope.RequestID)
		return nil
	}
	subject.LastSeen = time.Now()
	targets := rm.ParticipantsSnapshot()
	roomID := rm.ID()
	rm.Unlock()

	// Forward the original payload bytes verbatim — the server never
	// mutates mic/cam/screen values (NFR-003 / FR-091). Each
	// recipient gets one envelope with `from = sender.peerId` and
	// `to` unset (fan-out is participant-level, not unicast pair).
	envOut := protocol.Envelope{
		V:       protocol.ContractVersion,
		Type:    protocol.TypePairMediaState,
		RoomID:  roomID,
		From:    state.PeerID,
		TS:      time.Now().UnixMilli(),
		Payload: d.Envelope.Payload,
	}

	delivered := 0
	skipped := 0
	for _, p := range targets {
		if p.PeerID == state.PeerID {
			// Server fan-out NEVER includes the sender (§3.13 +
			// plan-prompt "do not send to the sender").
			continue
		}
		if p.Conn == nil {
			skipped++
			continue
		}
		if err := p.Conn.SendJSON(p.Conn.BaseContext(), envOut); err != nil {
			skipped++
			s.Log.Warn("pair_media_state fan-out send failed",
				slog.String("event", "mesh_pair_media_state_send_failed"),
				slog.String("room_id", roomID),
				slog.String("from", state.PeerID),
				slog.String("to", p.PeerID),
				slog.String("error", err.Error()),
			)
			continue
		}
		delivered++
	}

	s.Log.Info("pair_media_state fan-out",
		slog.String("event", "mesh_pair_media_state_fanout"),
		slog.String("room_id", roomID),
		slog.String("from", state.PeerID),
		slog.Int("delivered", delivered),
		slog.Int("skipped", skipped),
	)
	return nil
}
