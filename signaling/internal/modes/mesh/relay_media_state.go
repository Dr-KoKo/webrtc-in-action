// Server-side fan-out for `pair_media_state` (M9 / T071, contract §3.13).
//
// Semantics — `pair_media_state` is participant-level metadata, NOT a
// pairwise connection-attempt message. The server validates the
// sender, then fans the same payload bytes out to every OTHER
// admitted participant in the room with `from = sender.peerId`. No
// pairId / pairEpoch checks (§3.13 note: this message carries
// neither). Server constraints (NFR-003 + plan-prompt):
//
//   - Never relay any media payload (the payload here is metadata only).
//   - Never mutate the payload bytes.
//   - Never log mic/cam/screen values — counts + correlation only.
//   - Never send the envelope back to the sender.
//
// Contract §3.13 specifically requires the sender's readiness to be
// `media-ready` (a `released` or `left` sender must not be able to
// leak media-state to the room). We surface a `not_in_room` error to
// the sender on violation rather than silently dropping so a buggy
// client gets a typed response.

package mesh

import (
	"context"
	"log/slog"
	"time"

	"webrtc-lab/signaling/internal/modes/mesh/protocol"

	"webrtc-lab/signaling/internal/modes/mesh/room"
)

// handlePairMediaState — §3.13 server-fan-out.
func (h *Handler) handlePairMediaState(ctx context.Context, cc *SessionMesh, d *protocol.Decoded) error {
	// Sender must be admitted in some mesh room.
	if cc.peerID == "" || cc.roomID == "" {
		h.writeError(ctx, cc, &protocol.ProtocolError{
			Code:    protocol.CodeNotInRoom,
			Message: "pair_media_state requires an admitted participant",
		}, d.Envelope.RequestID)
		return nil
	}

	// Decode-time validator already ran via `decodeInto[protocol.PairMediaStatePayload]`
	// so the payload's three required fields are guaranteed present and
	// in their canonical enums. Re-check the type-assertion as a guard
	// against future code paths that construct a protocol.Decoded without going
	// through protocol.DecodeEnvelope.
	if _, ok := d.Message.(*protocol.PairMediaStatePayload); !ok {
		h.writeError(ctx, cc, &protocol.ProtocolError{
			Code:    protocol.CodeInternalError,
			Message: "pair_media_state decode mismatch",
		}, d.Envelope.RequestID)
		return nil
	}

	rm := h.Manager.Room(cc.roomID)
	if rm == nil {
		h.writeError(ctx, cc, &protocol.ProtocolError{
			Code:    protocol.CodeNotInRoom,
			Message: "mesh room not found",
		}, d.Envelope.RequestID)
		return nil
	}

	rm.Lock()
	subject := rm.FindByPeerID(cc.peerID)
	if subject == nil {
		rm.Unlock()
		h.writeError(ctx, cc, &protocol.ProtocolError{
			Code:    protocol.CodeNotInRoom,
			Message: "participant not found in room",
		}, d.Envelope.RequestID)
		return nil
	}
	// §3.13 server validation: a `released` or `left` sender (or one
	// still in `joined` pre-media-acquisition) must not leak media-state
	// to the room. media-ready is the only readiness that may publish.
	if subject.Readiness != room.ReadinessMediaReady {
		rm.Unlock()
		h.writeError(ctx, cc, &protocol.ProtocolError{
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
	// mutates mic/cam/screen values (NFR-003 / FR-091). Each recipient
	// gets one envelope with `from = sender.peerId` and `to` unset
	// (fan-out is participant-level, not unicast pair). `Payload` is
	// `json.RawMessage`, so re-marshaling preserves bytes exactly.
	envOut := protocol.Envelope{
		V:       protocol.ContractVersion,
		Type:    protocol.TypePairMediaState,
		RoomID:  roomID,
		From:    cc.peerID,
		TS:      time.Now().UnixMilli(),
		Payload: d.Envelope.Payload,
	}

	delivered := 0
	skipped := 0
	for _, p := range targets {
		if p.PeerID == cc.peerID {
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
			h.Log.Warn("pair_media_state fan-out send failed",
				slog.String("event", "mesh_pair_media_state_send_failed"),
				slog.String("room_id", roomID),
				slog.String("from", cc.peerID),
				slog.String("to", p.PeerID),
				slog.String("error", err.Error()),
			)
			continue
		}
		delivered++
	}

	// Log only counts + correlation IDs — never the values from the
	// payload (NFR-003 + plan-prompt: "do not log mic/cam/screen
	// values").
	h.Log.Info("pair_media_state fan-out",
		slog.String("event", "mesh_pair_media_state_fanout"),
		slog.String("room_id", roomID),
		slog.String("from", cc.peerID),
		slog.Int("delivered", delivered),
		slog.Int("skipped", skipped),
	)
	return nil
}
