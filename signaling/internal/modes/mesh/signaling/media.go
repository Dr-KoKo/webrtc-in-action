package signaling

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"webrtc-lab/signaling/internal/modes/mesh/protocol"
	"webrtc-lab/signaling/internal/modes/mesh/room"
)

// handleMediaReady implements §3.6. Transitions the participant
// readiness to media-ready and broadcasts the corresponding roster
// update. Per data-model §A.3, media_ready arriving from a
// non-`joined` readiness is rejected with `error { code:
// "unexpected_media_ready" }`.
func (s *Service) handleMediaReady(ctx context.Context, conn Conn, d *protocol.Decoded) error {
	state := conn.State()
	if state.PeerID == "" {
		s.writeError(ctx, conn, &protocol.ProtocolError{
			Code:    protocol.CodeNotInRoom,
			Message: "media_ready requires an admitted participant",
		}, d.Envelope.RequestID)
		return nil
	}
	// decodeInto[protocol.MediaReadyPayload] already runs Validate at
	// decode (protocol/messages.go enforces audio=true && video=true).
	// Re-check here as belt-and-braces in case a future code path
	// constructs a Decoded without going through DecodeEnvelope. Split
	// the type-assertion failure (server-side decode mismatch) from
	// the capability mismatch (client contract violation) so each
	// carries the right error code.
	payload, ok := d.Message.(*protocol.MediaReadyPayload)
	if !ok || payload == nil {
		s.writeError(ctx, conn, &protocol.ProtocolError{
			Code:    protocol.CodeInternalError,
			Message: "media_ready decode mismatch",
		}, d.Envelope.RequestID)
		return nil
	}
	if !payload.MediaCapabilities.Audio || !payload.MediaCapabilities.Video {
		s.writeError(ctx, conn, &protocol.ProtocolError{
			Code:    protocol.CodeUnsupportedMediaCapability,
			Message: "media_ready requires audio=true AND video=true",
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
	if subject.Readiness != room.ReadinessJoined {
		rm.Unlock()
		s.writeError(ctx, conn, &protocol.ProtocolError{
			Code:    protocol.CodeUnexpectedMediaReady,
			Message: "media_ready requires readiness=joined",
		}, d.Envelope.RequestID)
		return nil
	}
	subject.Readiness = room.ReadinessMediaReady
	subject.LastSeen = time.Now()
	rm.Unlock()

	// Broadcast roster update presence:media-ready (FR-012b).
	s.broadcastRosterUpdate(rm, subject, protocol.PresenceMediaReady, protocol.RosterReasonMediaReady)
	// Pair eligibility evaluator (T045 / §3.9). Emits one
	// `pair_negotiation_instruction` to each endpoint of every NEW
	// pair the subject formed with already-media-ready peers.
	s.evaluateAndEmitInstructions(rm, subject)
	s.Log.Info("mesh peer media-ready",
		slog.String("event", "mesh_peer_media_ready"),
		slog.String("conn_id", conn.ID()),
		slog.String("peer_id", state.PeerID),
		slog.String("room_id", state.RoomID),
	)
	return nil
}

// handleMediaFailed implements §3.7. Releases the sender's slot,
// emits `participant_released` to the sender, and broadcasts a
// `mesh_roster_update { presence: "released", reason: "media_failed" }`
// to the remaining participants. The admissionIndex value is
// preserved (data-model §A.4 — never reused).
func (s *Service) handleMediaFailed(ctx context.Context, conn Conn, d *protocol.Decoded) error {
	state := conn.State()
	if state.PeerID == "" {
		s.writeError(ctx, conn, &protocol.ProtocolError{
			Code:    protocol.CodeNotInRoom,
			Message: "media_failed requires an admitted participant",
		}, d.Envelope.RequestID)
		return nil
	}
	payload, _ := d.Message.(*protocol.MediaFailedPayload)
	detail := ""
	if payload != nil {
		detail = payload.Detail
	}

	// Step 1: release the slot (data-model §C.4). Captures the
	// remaining participants for the roster broadcast.
	outcome := s.Rooms.Release(state.RoomID, state.PeerID)
	conn.ReleaseOnce()
	if outcome.Departing == nil {
		// Already released somehow — emit nothing (idempotent).
		return nil
	}
	rm := outcome.Room

	// Step 2: send `participant_released` to the failing peer
	// (the sender is still WS-connected; the user may Retry).
	releasedPayload, _ := json.Marshal(protocol.ParticipantReleasedPayload{
		Result: protocol.ParticipantReleasedMediaFailed,
		Reason: protocol.ReleasedReasonMediaFailed,
		Detail: detail,
	})
	releasedEnv := protocol.Envelope{
		V:       protocol.ContractVersion,
		Type:    protocol.TypeParticipantReleased,
		RoomID:  rm.ID(),
		TS:      time.Now().UnixMilli(),
		Payload: releasedPayload,
	}
	if err := conn.SendJSON(ctx, releasedEnv); err != nil {
		s.Log.Warn("participant_released send failed",
			slog.String("peer_id", state.PeerID),
			slog.String("error", err.Error()))
	}

	// Step 3: broadcast `mesh_roster_update { presence: "released" }`
	// to remaining participants. Caller already released the slot,
	// so `outcome.Remaining` is the post-release roster.
	rm.Lock()
	update := buildRosterUpdate(rm, outcome.Departing, protocol.PresenceReleased, protocol.RosterReasonMediaFailed)
	rm.Unlock()
	updatePayload, _ := json.Marshal(update)
	updateEnv := protocol.Envelope{
		V:       protocol.ContractVersion,
		Type:    protocol.TypeMeshRosterUpdate,
		RoomID:  rm.ID(),
		TS:      time.Now().UnixMilli(),
		Payload: updatePayload,
	}
	for _, p := range outcome.Remaining {
		if p.Conn == nil {
			continue
		}
		if err := p.Conn.SendJSON(p.Conn.BaseContext(), updateEnv); err != nil {
			s.Log.Warn("mesh_roster_update send failed",
				slog.String("peer_id", p.PeerID),
				slog.String("error", err.Error()))
		}
	}

	// Local conn no longer references a participant. The WS stays
	// open so the user can Retry with a fresh `join_room` (contract
	// §3.8 client behavior).
	conn.ClearJoined()

	s.Log.Info("mesh peer released (media_failed)",
		slog.String("event", "mesh_peer_released"),
		slog.String("conn_id", conn.ID()),
		slog.String("peer_id", outcome.Departing.PeerID),
		slog.String("room_id", rm.ID()),
		slog.Bool("room_gc", outcome.RoomGarbageCollected),
	)
	return nil
}
