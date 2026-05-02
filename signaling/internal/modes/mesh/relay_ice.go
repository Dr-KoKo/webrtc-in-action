// room.Pair ICE-candidate relay (T055, contract §3.12). Validates the
// inbound `pair_ice_candidate` envelope (sender admitted, sender
// belongs to pairId, pair exists, pairEpoch matches, candidate shape
// is object|null), then forwards the original payload bytes verbatim
// to the other endpoint.
//
// Server constraints (NFR-003):
//   - The server MUST NOT parse, normalize, inspect, or log the
//     candidate string. ICE candidates contain TURN credentials and
//     network topology hints — leaking them to logs is a privacy
//     regression. Only counts + correlation IDs (`pairId`,
//     `pairEpoch`) reach slog.
//   - `candidate: null` is the canonical end-of-candidates form and
//     is relayed as-is.
//   - `candidate: ""` is rejected upstream by `protocol.PairIceCandidatePayload.protocol.Validate`
//     as `malformed`; the relay never sees it.
//
// Stale epoch  → `error stale_pair_epoch` to the sender; no forward.
// room.Pair unknown → `error stale_pair_epoch` (mirrors the SDP relay path
//                in relay.go; an unknown pairId from the client side is
//                treated as "the server's epoch is canonical").

package mesh

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"webrtc-lab/signaling/internal/modes/mesh/protocol"
)

// handlePairIceCandidate implements the §3.12 server-side relay path.
func (h *Handler) handlePairIceCandidate(ctx context.Context, cc *SessionMesh, d *protocol.Decoded) error {
	payload, ok := d.Message.(*protocol.PairIceCandidatePayload)
	if !ok || payload == nil {
		h.writeError(ctx, cc, &protocol.ProtocolError{
			Code:    protocol.CodeInternalError,
			Message: "pair_ice_candidate decode mismatch",
		}, d.Envelope.RequestID)
		return nil
	}
	return h.relayPairIce(ctx, cc, d, payload.PairID, payload.PairEpoch, d.Envelope.Payload)
}

// relayPairIce is the validate + forward path for pair_ice_candidate.
// It mirrors `relayPair` in `relay.go` but skips the role check —
// either endpoint of a pair may emit ICE candidates.
func (h *Handler) relayPairIce(
	ctx context.Context,
	cc *SessionMesh,
	d *protocol.Decoded,
	pairID string,
	pairEpoch uint64,
	rawPayload json.RawMessage,
) error {
	if cc.peerID == "" || cc.roomID == "" {
		h.writeError(ctx, cc, &protocol.ProtocolError{
			Code:    protocol.CodeNotInRoom,
			Message: "pair_ice_candidate requires an admitted participant",
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
	ledger := rm.PairLedger()
	if ledger == nil {
		rm.Unlock()
		h.writeError(ctx, cc, &protocol.ProtocolError{
			Code:    protocol.CodeInternalError,
			Message: "pair ledger unavailable",
		}, d.Envelope.RequestID)
		return nil
	}
	pair, exists := ledger.Lookup(pairID)
	if !exists {
		rm.Unlock()
		h.writeError(ctx, cc, &protocol.ProtocolError{
			Code:    protocol.CodeStalePairEpoch,
			Message: "pair " + pairID + " is unknown to the server",
		}, d.Envelope.RequestID)
		return nil
	}
	// Sender must belong to the pair (any role is acceptable for ICE).
	senderIsLo := pair.LoPeerID == cc.peerID
	senderIsHi := pair.HiPeerID == cc.peerID
	if !senderIsLo && !senderIsHi {
		rm.Unlock()
		h.writeError(ctx, cc, &protocol.ProtocolError{
			Code:    protocol.CodeMalformed,
			Message: "sender does not belong to pair " + pairID,
		}, d.Envelope.RequestID)
		return nil
	}
	if perr := protocol.ValidateStalePairEpoch(pairID, pairEpoch, ledger); perr != nil {
		rm.Unlock()
		h.writeError(ctx, cc, perr, d.Envelope.RequestID)
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
		// Recipient disappeared between admission and relay. Drop
		// silently; M11 will surface this via pair_failed.
		h.Log.Info("pair_ice_candidate recipient absent",
			slog.String("event", "mesh_pair_ice_relay_recipient_absent"),
			slog.String("room_id", roomID),
			slog.String("pair_id", pairID),
		)
		return nil
	}

	envOut := protocol.Envelope{
		V:      protocol.ContractVersion,
		Type:   protocol.TypePairIceCandidate,
		RoomID: roomID,
		From:   cc.peerID,
		To:     recipientPeerID,
		TS:     time.Now().UnixMilli(),
		// Forward bytes verbatim — server NEVER parses or mutates
		// the candidate string (NFR-003).
		Payload: rawPayload,
	}
	if err := recipient.Conn.SendJSON(recipient.Conn.BaseContext(), envOut); err != nil {
		h.Log.Warn("pair_ice_candidate forward failed",
			slog.String("event", "mesh_pair_ice_relay_send_failed"),
			slog.String("pair_id", pairID),
			slog.String("to", recipientPeerID),
			slog.String("error", err.Error()),
		)
		return nil
	}
	h.Log.Info("pair_ice_candidate forwarded",
		slog.String("event", "mesh_pair_ice_relay_forwarded"),
		slog.String("room_id", roomID),
		slog.String("pair_id", pairID),
		slog.Uint64("pair_epoch", pairEpoch),
		slog.String("from", cc.peerID),
		slog.String("to", recipientPeerID),
	)
	return nil
}
