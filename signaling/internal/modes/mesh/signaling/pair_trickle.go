// pair_trickle — §3.12. Pair ICE-candidate relay. Validates the
// inbound `pair_ice_candidate` envelope (sender admitted, sender
// belongs to pairId, pair exists, pairEpoch matches, candidate
// shape is object|null), then forwards the original payload bytes
// verbatim to the other endpoint.
//
// Server constraints (NFR-003):
//   - The server MUST NOT parse, normalize, inspect, or log the
//     candidate string. ICE candidates contain TURN credentials and
//     network topology hints — leaking them to logs is a privacy
//     regression. Only counts + correlation IDs (`pairId`,
//     `pairEpoch`) reach slog.
//   - `candidate: null` is the canonical end-of-candidates form and
//     is relayed as-is.
//   - `candidate: ""` is rejected upstream by
//     `protocol.PairIceCandidatePayload.Validate` as `malformed`;
//     the relay never sees it.

package signaling

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"webrtc-lab/signaling/internal/modes/mesh/protocol"
)

// handlePairIceCandidate implements the §3.12 server-side relay
// path.
func (s *Service) handlePairIceCandidate(ctx context.Context, conn Conn, d *protocol.Decoded) error {
	payload, ok := d.Message.(*protocol.PairIceCandidatePayload)
	if !ok || payload == nil {
		s.writeError(ctx, conn, &protocol.ProtocolError{
			Code:    protocol.CodeInternalError,
			Message: "pair_ice_candidate decode mismatch",
		}, d.Envelope.RequestID)
		return nil
	}
	return s.relayPairIce(ctx, conn, d, payload.PairID, payload.PairEpoch, d.Envelope.Payload)
}

// relayPairIce mirrors relayPair but skips the role check — either
// endpoint of a pair may emit ICE candidates.
func (s *Service) relayPairIce(
	ctx context.Context,
	conn Conn,
	d *protocol.Decoded,
	pairID string,
	pairEpoch uint64,
	rawPayload json.RawMessage,
) error {
	state := conn.State()
	if state.PeerID == "" || state.RoomID == "" {
		s.writeError(ctx, conn, &protocol.ProtocolError{
			Code:    protocol.CodeNotInRoom,
			Message: "pair_ice_candidate requires an admitted participant",
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
		s.writeError(ctx, conn, &protocol.ProtocolError{
			Code:    protocol.CodeMalformed,
			Message: "sender does not belong to pair " + pairID,
		}, d.Envelope.RequestID)
		return nil
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
		s.Log.Info("pair_ice_candidate recipient absent",
			slog.String("event", "mesh_pair_ice_relay_recipient_absent"),
			slog.String("room_id", roomID),
			slog.String("pair_id", pairID),
		)
		return nil
	}

	envOut := protocol.Envelope{
		V:       protocol.ContractVersion,
		Type:    protocol.TypePairIceCandidate,
		RoomID:  roomID,
		From:    state.PeerID,
		To:      recipientPeerID,
		TS:      time.Now().UnixMilli(),
		Payload: rawPayload,
	}
	if err := recipient.Conn.SendJSON(recipient.Conn.BaseContext(), envOut); err != nil {
		s.Log.Warn("pair_ice_candidate forward failed",
			slog.String("event", "mesh_pair_ice_relay_send_failed"),
			slog.String("pair_id", pairID),
			slog.String("to", recipientPeerID),
			slog.String("error", err.Error()),
		)
		return nil
	}
	s.Log.Info("pair_ice_candidate forwarded",
		slog.String("event", "mesh_pair_ice_relay_forwarded"),
		slog.String("room_id", roomID),
		slog.String("pair_id", pairID),
		slog.Uint64("pair_epoch", pairEpoch),
		slog.String("from", state.PeerID),
		slog.String("to", recipientPeerID),
	)
	return nil
}
