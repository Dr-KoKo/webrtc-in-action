// room.Pair offer/answer relay (T049, contract §3.10 + §3.11). Validates
// the inbound envelope (sender admitted, sender belongs to pairId,
// pair exists, pairEpoch matches, role matches), stamps `from` =
// sender peerId, and forwards once to the matched `to`.
//
// Stale epoch  → `error stale_pair_epoch` to the sender; no forward.
// Wrong role   → `error unexpected_offer | unexpected_answer`; no forward.
// room.Pair unknown → `error stale_pair_epoch` (mirrors the pair-ledger
//                contract — an unknown pairId from the client side is
//                always treated as "the server's epoch is canonical").
//
// Server constraints (NFR-003):
//   - Never parses sdp.sdp.
//   - Never logs sdp.sdp / ICE / TURN credentials.
//   - Logs only counts + correlation IDs (`pairId`, `pairEpoch`).

package mesh

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"webrtc-lab/signaling/internal/modes/mesh/protocol"
)

// pairRelayKind discriminates offer-vs-answer at the relay level so
// the same plumbing covers both message types.
type pairRelayKind int

const (
	relayKindOffer pairRelayKind = iota
	relayKindAnswer
)

// handlePairOffer implements the §3.10 server-side relay path.
func (h *Handler) handlePairOffer(ctx context.Context, cc *SessionMesh, d *protocol.Decoded) error {
	payload, ok := d.Message.(*protocol.PairOfferPayload)
	if !ok || payload == nil {
		h.writeError(ctx, cc, &protocol.ProtocolError{
			Code:    protocol.CodeInternalError,
			Message: "pair_offer decode mismatch",
		}, d.Envelope.RequestID)
		return nil
	}
	return h.relayPair(ctx, cc, d, relayKindOffer, payload.PairID, payload.PairEpoch, payload.SDP.Type, d.Envelope.Payload)
}

// handlePairAnswer implements the §3.11 server-side relay path.
func (h *Handler) handlePairAnswer(ctx context.Context, cc *SessionMesh, d *protocol.Decoded) error {
	payload, ok := d.Message.(*protocol.PairAnswerPayload)
	if !ok || payload == nil {
		h.writeError(ctx, cc, &protocol.ProtocolError{
			Code:    protocol.CodeInternalError,
			Message: "pair_answer decode mismatch",
		}, d.Envelope.RequestID)
		return nil
	}
	return h.relayPair(ctx, cc, d, relayKindAnswer, payload.PairID, payload.PairEpoch, payload.SDP.Type, d.Envelope.Payload)
}

// relayPair is the shared validate + forward path for pair_offer /
// pair_answer. The decoded payload bytes are forwarded as-is (the
// server never parses sdp).
func (h *Handler) relayPair(
	ctx context.Context,
	cc *SessionMesh,
	d *protocol.Decoded,
	kind pairRelayKind,
	pairID string,
	pairEpoch uint64,
	sdpType string,
	rawPayload json.RawMessage,
) error {
	// Sender must be admitted in some mesh room.
	if cc.peerID == "" || cc.roomID == "" {
		h.writeError(ctx, cc, &protocol.ProtocolError{
			Code:    protocol.CodeNotInRoom,
			Message: "pair message requires an admitted participant",
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
	// Sender must belong to the pair.
	senderIsLo := pair.LoPeerID == cc.peerID
	senderIsHi := pair.HiPeerID == cc.peerID
	if !senderIsLo && !senderIsHi {
		rm.Unlock()
		// Treat as wrong role — sender pretends to belong to a pair
		// they're not part of. The two `unexpected_*` codes are the
		// canonical surface (§3.19).
		h.writeError(ctx, cc, wrongRoleError(kind, "sender does not belong to pair "+pairID), d.Envelope.RequestID)
		return nil
	}
	// Sender role must match the message kind.
	switch kind {
	case relayKindOffer:
		if !senderIsLo {
			rm.Unlock()
			h.writeError(ctx, cc, &protocol.ProtocolError{
				Code:    protocol.CodeUnexpectedOffer,
				Message: "pair_offer must come from the offerer (lower admissionIndex)",
			}, d.Envelope.RequestID)
			return nil
		}
		if sdpType != "offer" {
			rm.Unlock()
			h.writeError(ctx, cc, &protocol.ProtocolError{
				Code:    protocol.CodeMalformed,
				Message: "pair_offer.sdp.type must be 'offer'",
			}, d.Envelope.RequestID)
			return nil
		}
	case relayKindAnswer:
		if !senderIsHi {
			rm.Unlock()
			h.writeError(ctx, cc, &protocol.ProtocolError{
				Code:    protocol.CodeUnexpectedAnswer,
				Message: "pair_answer must come from the answerer (higher admissionIndex)",
			}, d.Envelope.RequestID)
			return nil
		}
		if sdpType != "answer" {
			rm.Unlock()
			h.writeError(ctx, cc, &protocol.ProtocolError{
				Code:    protocol.CodeMalformed,
				Message: "pair_answer.sdp.type must be 'answer'",
			}, d.Envelope.RequestID)
			return nil
		}
	}
	// Epoch check (§A.5).
	if perr := protocol.ValidateStalePairEpoch(pairID, pairEpoch, ledger); perr != nil {
		rm.Unlock()
		h.writeError(ctx, cc, perr, d.Envelope.RequestID)
		return nil
	}
	// Resolve recipient = the other endpoint.
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
		// Recipient gone — drop silently. Future M11 surfaces this via
		// `pair_failed`; M6 only proves the relay path.
		h.Log.Info("pair relay recipient absent",
			slog.String("event", "mesh_pair_relay_recipient_absent"),
			slog.String("room_id", roomID),
			slog.String("pair_id", pairID),
			slog.String("kind", relayKindLabel(kind)),
		)
		return nil
	}

	// Stamp from + to and forward the original payload bytes verbatim.
	// The server never parses or mutates sdp.sdp.
	envOut := protocol.Envelope{
		V:       protocol.ContractVersion,
		Type:    pairRelayType(kind),
		RoomID:  roomID,
		From:    cc.peerID,
		To:      recipientPeerID,
		TS:      time.Now().UnixMilli(),
		Payload: rawPayload,
	}
	if err := recipient.Conn.SendJSON(recipient.Conn.BaseContext(), envOut); err != nil {
		h.Log.Warn("pair relay forward failed",
			slog.String("event", "mesh_pair_relay_send_failed"),
			slog.String("kind", relayKindLabel(kind)),
			slog.String("pair_id", pairID),
			slog.String("to", recipientPeerID),
			slog.String("error", err.Error()),
		)
		return nil
	}
	h.Log.Info("pair relay forwarded",
		slog.String("event", "mesh_pair_relay_forwarded"),
		slog.String("room_id", roomID),
		slog.String("pair_id", pairID),
		slog.Uint64("pair_epoch", pairEpoch),
		slog.String("kind", relayKindLabel(kind)),
		slog.String("from", cc.peerID),
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
