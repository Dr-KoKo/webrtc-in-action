// Server `reconnect_pair` + `pair_failed` handlers (M11 / T081 + T084,
// contract §3.14–§3.16).
//
// Two pair-scoped flows live here:
//
//   1. `pair_failed` (C→S→C) — endpoint-detected pair failure. The
//      server validates `pairId` + `pairEpoch`, marks the server-side
//      Pair.State = PairFailed (bookkeeping), forwards the original
//      payload bytes to the OTHER endpoint of the pair only, and does
//      NOT broadcast `mesh_roster_update { presence: "failed" }` to
//      the room (FR-025: failed presence is per-(viewer, subject) and
//      derived locally from each client's PairContext).
//
//   2. `reconnect_pair` (C→S) — user clicked Reconnect on a failed
//      tile. The server validates pair membership + state + observed
//      epoch under the per-room mutex (which serializes simultaneous
//      clicks → exactly one winner); on success it increments
//      `pairEpoch[pairId]` by exactly +1, transitions Pair.State =
//      PairReconnecting, and emits `pair_reconnect_instruction` to
//      both endpoints with the new epoch. The losing side of a
//      simultaneous-click race observes `stale_pair_epoch` and does
//      not increment a second time.
//
// Server invariants (NFR-003 + plan §10):
//   - Never parses or stores SDP / ICE / TURN credentials.
//   - Never touches unrelated pairs.
//   - Never emits room-wide "failed" roster (FR-025).
//   - The canonical role rule (§3.9) — lower admissionIndex is
//     offerer — is reused by re-emission of pair_reconnect_instruction.

package mesh

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"
)

// handlePairFailed implements §3.16 — endpoint-detected failure relay.
// Mirrors the validation shape of `relayPairIce` (relay_ice.go) but
// also flips the server-side Pair.State so a subsequent
// `reconnect_pair` can validate the failed precondition.
func (h *Handler) handlePairFailed(ctx context.Context, cc *meshConn, d *Decoded) error {
	payload, ok := d.Message.(*PairFailedPayload)
	if !ok || payload == nil {
		h.writeError(ctx, cc, &ProtocolError{
			Code:    CodeInternalError,
			Message: "pair_failed decode mismatch",
		}, d.Envelope.RequestID)
		return nil
	}
	if cc.peerID == "" || cc.roomID == "" {
		h.writeError(ctx, cc, &ProtocolError{
			Code:    CodeNotInRoom,
			Message: "pair_failed requires an admitted participant",
		}, d.Envelope.RequestID)
		return nil
	}
	rm := h.Manager.Room(cc.roomID)
	if rm == nil {
		h.writeError(ctx, cc, &ProtocolError{
			Code:    CodeNotInRoom,
			Message: "mesh room not found",
		}, d.Envelope.RequestID)
		return nil
	}

	rm.Lock()
	ledger, _ := rm.PairLedger().(*pairLedger)
	if ledger == nil {
		rm.Unlock()
		h.writeError(ctx, cc, &ProtocolError{
			Code:    CodeInternalError,
			Message: "pair ledger unavailable",
		}, d.Envelope.RequestID)
		return nil
	}
	pair, exists := ledger.pairs[payload.PairID]
	if !exists {
		rm.Unlock()
		// Mirrors the relay path's "unknown pair = canonical stale".
		h.writeError(ctx, cc, &ProtocolError{
			Code:    CodeStalePairEpoch,
			Message: "pair " + payload.PairID + " is unknown to the server",
		}, d.Envelope.RequestID)
		return nil
	}
	senderIsLo := pair.LoPeerID == cc.peerID
	senderIsHi := pair.HiPeerID == cc.peerID
	if !senderIsLo && !senderIsHi {
		rm.Unlock()
		h.writeError(ctx, cc, &ProtocolError{
			Code:    CodeMalformed,
			Message: "sender does not belong to pair " + payload.PairID,
		}, d.Envelope.RequestID)
		return nil
	}
	if perr := ValidateStalePairEpoch(payload.PairID, payload.PairEpoch, ledger); perr != nil {
		rm.Unlock()
		h.writeError(ctx, cc, perr, d.Envelope.RequestID)
		return nil
	}
	// Server-side bookkeeping: mark the pair failed so a follow-up
	// `reconnect_pair` can validate the precondition.
	pair.State = PairFailed
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
		// Other endpoint is gone — drop. FR-025 forbids broadcasting
		// `failed` to unrelated peers; nothing else to do.
		h.Log.Info("pair_failed recipient absent",
			slog.String("event", "mesh_pair_failed_recipient_absent"),
			slog.String("room_id", roomID),
			slog.String("pair_id", payload.PairID),
		)
		return nil
	}

	envOut := Envelope{
		V:       ContractVersion,
		Type:    TypePairFailed,
		RoomID:  roomID,
		From:    cc.peerID,
		To:      recipientPeerID,
		TS:      time.Now().UnixMilli(),
		// Forward original payload bytes verbatim (NFR-003).
		Payload: d.Envelope.Payload,
	}
	if err := recipient.Conn.SendJSON(envOut); err != nil {
		h.Log.Warn("pair_failed forward failed",
			slog.String("event", "mesh_pair_failed_send_failed"),
			slog.String("pair_id", payload.PairID),
			slog.String("to", recipientPeerID),
			slog.String("error", err.Error()),
		)
		return nil
	}
	h.Log.Info("pair_failed forwarded",
		slog.String("event", "mesh_pair_failed_forwarded"),
		slog.String("room_id", roomID),
		slog.String("pair_id", payload.PairID),
		slog.Uint64("pair_epoch", payload.PairEpoch),
		slog.String("reason", string(payload.Reason)),
		slog.String("from", cc.peerID),
		slog.String("to", recipientPeerID),
	)
	return nil
}

// handleReconnectPair implements §3.14 — request a fresh attempt for
// one pair. Per-pair mutual exclusion is provided by the room mutex
// (the only path that mutates `pairLedger`); a simultaneous-click race
// resolves deterministically: one request acquires the lock first,
// validates observedEpoch == current, increments epoch, and emits the
// pair_reconnect_instruction; the second request observes the
// already-incremented epoch and receives `stale_pair_epoch`.
func (h *Handler) handleReconnectPair(ctx context.Context, cc *meshConn, d *Decoded) error {
	payload, ok := d.Message.(*ReconnectPairPayload)
	if !ok || payload == nil {
		h.writeError(ctx, cc, &ProtocolError{
			Code:    CodeInternalError,
			Message: "reconnect_pair decode mismatch",
		}, d.Envelope.RequestID)
		return nil
	}
	if cc.peerID == "" || cc.roomID == "" {
		h.writeError(ctx, cc, &ProtocolError{
			Code:    CodeNotInRoom,
			Message: "reconnect_pair requires an admitted participant",
		}, d.Envelope.RequestID)
		return nil
	}
	rm := h.Manager.Room(cc.roomID)
	if rm == nil {
		h.writeError(ctx, cc, &ProtocolError{
			Code:    CodeNotInRoom,
			Message: "mesh room not found",
		}, d.Envelope.RequestID)
		return nil
	}

	rm.Lock()
	ledger, _ := rm.PairLedger().(*pairLedger)
	if ledger == nil {
		rm.Unlock()
		h.writeError(ctx, cc, &ProtocolError{
			Code:    CodeInternalError,
			Message: "pair ledger unavailable",
		}, d.Envelope.RequestID)
		return nil
	}
	pair, exists := ledger.pairs[payload.PairID]
	if !exists {
		rm.Unlock()
		// canonical-equivalent of an `unknown_pair` code; same shape as
		// the relay paths use. The message disambiguates from
		// observedEpoch < current.
		h.writeErrorWithContext(ctx, cc, &ProtocolError{
			Code:    CodeStalePairEpoch,
			Message: "pair " + payload.PairID + " is unknown to the server",
		}, d.Envelope.RequestID, map[string]any{
			"pairId":  payload.PairID,
			"subcode": "unknown_pair",
		})
		return nil
	}
	senderIsLo := pair.LoPeerID == cc.peerID
	senderIsHi := pair.HiPeerID == cc.peerID
	if !senderIsLo && !senderIsHi {
		rm.Unlock()
		h.writeErrorWithContext(ctx, cc, &ProtocolError{
			Code:    CodeMalformed,
			Message: "sender does not belong to pair " + payload.PairID,
		}, d.Envelope.RequestID, map[string]any{
			"pairId":  payload.PairID,
			"subcode": "not_pair_member",
		})
		return nil
	}
	// Order matters: validate observedEpoch BEFORE state. In a
	// simultaneous-click race the first request bumps the epoch AND
	// flips state to PairReconnecting; the loser observes BOTH the new
	// epoch AND the new state, but the canonical signal per contract
	// §3.14 is `stale_pair_epoch` (so both clients can self-correct
	// onto the winner's epoch). State-check first would shadow the
	// epoch signal with a misleading `pair_not_failed`.
	current, _ := ledger.epochs[payload.PairID]
	if payload.ObservedEpoch != current {
		// Includes both stale (< current — common simultaneous-click
		// race outcome) and futuristic (> current — client invented an
		// epoch). Per contract §3.14, both surface as `stale_pair_epoch`
		// with `expected = current` so the client can self-correct.
		rm.Unlock()
		h.writeErrorWithContext(ctx, cc, &ProtocolError{
			Code: CodeStalePairEpoch,
			Message: "reconnect_pair observedEpoch is stale; server is canonical",
		}, d.Envelope.RequestID, map[string]any{
			"pairId":   payload.PairID,
			"expected": current,
			"observed": payload.ObservedEpoch,
		})
		return nil
	}
	if pair.State != PairFailed {
		rm.Unlock()
		h.writeErrorWithContext(ctx, cc, &ProtocolError{
			Code:    CodeMalformed,
			Message: "pair " + payload.PairID + " is not in failed state",
		}, d.Envelope.RequestID, map[string]any{
			"pairId":  payload.PairID,
			"subcode": "pair_not_failed",
			"state":   pair.State,
		})
		return nil
	}
	// Resolve both endpoints under the lock BEFORE incrementing the
	// epoch. If one of them disconnected between pair_failed and this
	// reconnect_pair (Manager.Release removed it from r.participants
	// while the pair entry survived), bumping the epoch here would
	// corrupt the ledger: no `pair_reconnect_instruction` could be
	// emitted (the original code would also have nil-deref'd
	// `remote.PeerID` inside the emit closure), and the surviving
	// peer's later reconnect would carry a stale observedEpoch and be
	// rejected indefinitely. Refusing here lets the surviving peer
	// self-correct once it processes the `mesh_roster_update
	// presence=left` for the missing endpoint.
	loPeer := rm.FindByPeerID(pair.LoPeerID)
	hiPeer := rm.FindByPeerID(pair.HiPeerID)
	if loPeer == nil || hiPeer == nil {
		rm.Unlock()
		h.writeErrorWithContext(ctx, cc, &ProtocolError{
			Code:    CodeNotInRoom,
			Message: "remote endpoint of pair " + payload.PairID + " is no longer in the room",
		}, d.Envelope.RequestID, map[string]any{
			"pairId":  payload.PairID,
			"subcode": "remote_left",
		})
		return nil
	}
	// All validation passed — increment the epoch under the lock so a
	// second simultaneous click cannot also mint a new attempt.
	newEpoch, _ := ledger.Increment(payload.PairID)
	pair.State = PairReconnecting
	loIdx := loPeer.AdmissionIndex
	hiIdx := hiPeer.AdmissionIndex
	roomID := rm.ID()
	iceServers := h.Manager.IceServers()
	rm.Unlock()

	// Emit `pair_reconnect_instruction` to both endpoints. The lower
	// admissionIndex is always the offerer (§3.9) so the same
	// deterministic role rule applies after every fresh attempt.
	emitOne := func(recipient *Participant, role PairRole, remote *Participant, remoteIdx uint64) {
		if recipient == nil || recipient.Conn == nil || remote == nil {
			return
		}
		body, _ := json.Marshal(PairReconnectInstructionPayload{
			pairIdentity: pairIdentity{
				PairID:    payload.PairID,
				PairEpoch: newEpoch,
			},
			Role: role,
			RemotePeer: RemotePeerRef{
				PeerID:         remote.PeerID,
				AdmissionIndex: remoteIdx,
			},
			IceServers: iceServers,
		})
		env := Envelope{
			V:       ContractVersion,
			Type:    TypePairReconnectInstruction,
			RoomID:  roomID,
			To:      recipient.PeerID,
			TS:      time.Now().UnixMilli(),
			Payload: body,
		}
		if err := recipient.Conn.SendJSON(env); err != nil {
			h.Log.Warn("pair_reconnect_instruction send failed",
				slog.String("event", "mesh_pair_reconnect_instruction_send_failed"),
				slog.String("pair_id", payload.PairID),
				slog.String("to", recipient.PeerID),
				slog.String("error", err.Error()),
			)
			return
		}
		h.Log.Info("pair_reconnect_instruction emitted",
			slog.String("event", "mesh_pair_reconnect_instruction_emitted"),
			slog.String("room_id", roomID),
			slog.String("pair_id", payload.PairID),
			slog.Uint64("pair_epoch", newEpoch),
			slog.String("role", string(role)),
			slog.String("to", recipient.PeerID),
		)
	}
	emitOne(loPeer, RoleOfferer, hiPeer, hiIdx)
	emitOne(hiPeer, RoleAnswerer, loPeer, loIdx)
	return nil
}

// writeErrorWithContext is the same as writeError but also includes
// the canonical `context` map (`pairId`, `expected`, etc.) per
// contract §3.19. Lets clients route a pair-scoped error back to the
// matching PairContext / button without parsing the message string.
func (h *Handler) writeErrorWithContext(
	ctx context.Context,
	cc *meshConn,
	perr *ProtocolError,
	correlates string,
	context map[string]any,
) {
	payload, _ := json.Marshal(ErrorPayload{
		Code:       perr.Code,
		Message:    perr.Message,
		Correlates: correlates,
		Context:    context,
	})
	env := Envelope{
		V:       ContractVersion,
		Type:    TypeError,
		TS:      time.Now().UnixMilli(),
		Payload: payload,
	}
	_ = cc.sendJSON(ctx, env)
}
