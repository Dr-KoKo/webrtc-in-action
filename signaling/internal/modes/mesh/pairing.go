// room.Pair eligibility evaluator (T045, contract §3.9, FR-022 + FR-022a).
//
// When a participant transitions to `media-ready`, this module looks at
// every other already-`media-ready` participant in the same room, asks
// the per-room pair ledger to register the missing pairs at epoch 1,
// and emits one `pair_negotiation_instruction` per endpoint.
//
// Existing-pair stability (FR-022a / L18): only NEW pairs receive
// instructions. Any pair already in the ledger — `Pairing`, `Connected`,
// or otherwise — is left untouched. A 4th media-ready peer joining an
// A/B/C room therefore produces exactly 3 instruction pairs (A↔K, B↔K,
// C↔K), not 6, and never re-emits A↔B / A↔C / B↔C.
//
// Offerer rule (§3.9): the participant with the lower `admissionIndex`
// of the pair is the offerer.
//
// The caller (handler.handleMediaReady) holds NO locks when calling
// EvaluateAndEmit; the function takes the room mutex internally.
// Sends fan out under the per-conn write mutex inside `SessionMesh`.

package mesh

import (
	"encoding/json"
	"log/slog"
	"time"

	"webrtc-lab/signaling/internal/modes/mesh/protocol"

	"webrtc-lab/signaling/internal/modes/mesh/room"
)

// pairInstruction is one (pairId, role, recipient, remote) tuple
// derived from the room's post-transition state. We collect these
// while holding the room lock and emit them after release so the
// outbound fan-out never races a concurrent admission.
type pairInstruction struct {
	pairID    string
	pairEpoch uint64
	role      protocol.PairRole
	recipient *room.Participant
	remote    *room.Participant
}

// EvaluateAndEmitInstructions runs the §3.9 evaluator for the supplied
// `subject` (just-transitioned participant) inside `rm`. It returns the
// number of pair_negotiation_instruction envelopes the server emitted.
//
// Caller must NOT hold the room lock.
func (h *Handler) EvaluateAndEmitInstructions(rm *room.Room, subject *room.Participant) int {
	if rm == nil || subject == nil {
		return 0
	}
	rm.Lock()
	// Recompute the eligibility set under the lock so we don't race a
	// concurrent media_ready / leave / release on a peer.
	current := rm.FindByPeerID(subject.PeerID)
	if current == nil || current.Readiness != room.ReadinessMediaReady {
		rm.Unlock()
		return 0
	}
	ledger := rm.PairLedger()
	ok := ledger != nil
	if !ok || ledger == nil {
		rm.Unlock()
		return 0
	}
	parts := rm.ParticipantsSnapshot()
	iceServers := h.IceServers

	instructions := make([]pairInstruction, 0, 2*(len(parts)-1))
	for _, peer := range parts {
		if peer.PeerID == current.PeerID {
			continue
		}
		if peer.Readiness != room.ReadinessMediaReady {
			continue
		}
		// Evaluate against the ledger's current state; pre-existing
		// pairs MUST NOT receive instructions (FR-022a / L18).
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
			// Existing pair (any state) — defensive no-op; preserves
			// pc, dc, senders, states, pairEpoch on both clients.
			continue
		}
		pair, epoch := ledger.Register(pairID, loPeer.PeerID, hiPeer.PeerID)
		// Mark as Pairing so future evaluator passes recognize it as
		// in-flight (also lets future M11 reconnect logic differentiate
		// from room.PairIdle).
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

	// Fan-out: marshal once per (pairId, role) instruction; each
	// recipient gets their own envelope with `to` = recipient.PeerID.
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
			h.Log.Warn("pair_negotiation_instruction send failed",
				slog.String("event", "mesh_pair_instruction_send_failed"),
				slog.String("peer_id", ins.recipient.PeerID),
				slog.String("pair_id", ins.pairID),
				slog.String("role", string(ins.role)),
				slog.String("error", err.Error()),
			)
			continue
		}
		h.Log.Info("pair_negotiation_instruction emitted",
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
