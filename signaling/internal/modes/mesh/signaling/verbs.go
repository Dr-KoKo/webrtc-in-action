// verbs.go is the monolithic landing site for the mesh verb method
// bodies during commit 2.B2. Commit 2.C splits this into one file
// per WebRTC concept: admission.go, media.go, pair_negotiation.go,
// pair_trickle.go, pair_media.go, roster.go, reconnect.go,
// presence.go.

package signaling

import (
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"time"

	"webrtc-lab/signaling/internal/modes/mesh/protocol"
	"webrtc-lab/signaling/internal/modes/mesh/room"
)

// ---------------------------------------------------------------------
// admission — §§3.1–3.3
// ---------------------------------------------------------------------

// handleJoinRoom implements §3.1 + §3.2 + §3.3 + §3.4.
func (s *Service) handleJoinRoom(ctx context.Context, conn Conn, d *protocol.Decoded) error {
	if conn.State().PeerID != "" {
		s.writeError(ctx, conn, &protocol.ProtocolError{
			Code:    protocol.CodeAlreadyJoined,
			Message: "this connection has already joined a mesh room",
		}, d.Envelope.RequestID)
		return nil
	}
	// Contract §1.1: trim surrounding whitespace before validation.
	// Done at handler entry rather than inside protocol.ValidateRoomID
	// so the validator stays a pure regex check; trimmed value is used
	// for every downstream lookup so "demo " and "demo" map to the same
	// room.Room.
	roomID := strings.TrimSpace(d.Envelope.RoomID)
	if err := protocol.ValidateRoomID(roomID); err != nil {
		s.sendJoinRejected(ctx, conn, roomID, d.Envelope.RequestID,
			protocol.JoinRejectedInvalidRoom, protocol.ReasonInvalidRoomID,
			"Room ID must match ^[A-Za-z0-9._-]{1,64}$.")
		return nil
	}
	outcome := s.Rooms.JoinOrCreate(roomID, conn)
	switch outcome.Result {
	case room.JoinRejectedRoomFullRes:
		s.sendJoinRejected(ctx, conn, roomID, d.Envelope.RequestID,
			protocol.JoinRejectedRoomFull, protocol.ReasonRoomFull,
			"Mesh room '"+roomID+"' already has 4 reserved participants.")
		return nil
	case room.JoinAccepted:
		conn.MarkJoined(outcome.Participant.PeerID, roomID)
		// Reset the disconnect-cleanup latch so a future ungraceful
		// close on this WS triggers `releaseAndNotify` for the freshly
		// admitted participant. Important when the user retries after
		// a `media_failed` release.
		conn.ResetReleaseLatch()
	}

	// join_accepted (§3.2)
	acceptPayload, _ := json.Marshal(protocol.JoinAcceptedPayload{
		PeerID:         outcome.Participant.PeerID,
		AdmissionIndex: outcome.Participant.AdmissionIndex,
		IceServers:     s.ICE,
	})
	if err := conn.SendJSON(ctx, protocol.Envelope{
		V:         protocol.ContractVersion,
		Type:      protocol.TypeJoinAccepted,
		RoomID:    roomID,
		RequestID: d.Envelope.RequestID,
		TS:        time.Now().UnixMilli(),
		Payload:   acceptPayload,
	}); err != nil {
		s.Log.Warn("mesh join_accepted send failed",
			slog.String("conn_id", conn.ID()), slog.String("error", err.Error()))
	}

	// mesh_roster_snapshot (§3.4) — sent immediately after join_accepted.
	rm := outcome.Room
	rm.Lock()
	snapshot := buildRosterSnapshot(rm)
	rm.Unlock()
	snapshotPayload, _ := json.Marshal(snapshot)
	if err := conn.SendJSON(ctx, protocol.Envelope{
		V:       protocol.ContractVersion,
		Type:    protocol.TypeMeshRosterSnapshot,
		RoomID:  roomID,
		TS:      time.Now().UnixMilli(),
		Payload: snapshotPayload,
	}); err != nil {
		s.Log.Warn("mesh_roster_snapshot send failed",
			slog.String("conn_id", conn.ID()), slog.String("error", err.Error()))
	}

	// mesh_roster_update (§3.5) — broadcast presence:joined to ALL
	// participants in the room INCLUDING the subject.
	s.broadcastRosterUpdate(rm, outcome.Participant, protocol.PresenceJoined, protocol.RosterReasonAdmitted)

	state := conn.State()
	s.Log.Info("mesh peer admitted",
		slog.String("event", "mesh_peer_admitted"),
		slog.String("conn_id", conn.ID()),
		slog.String("peer_id", state.PeerID),
		slog.String("room_id", roomID),
		slog.Uint64("admission_index", outcome.Participant.AdmissionIndex),
	)
	return nil
}

// sendJoinRejected centralizes the join_rejected send.
func (s *Service) sendJoinRejected(ctx context.Context, conn Conn, roomID, requestID string, result protocol.JoinRejectedResult, reason protocol.JoinRejectedReason, message string) {
	payload, _ := json.Marshal(protocol.JoinRejectedPayload{
		Result:  result,
		Reason:  reason,
		Message: message,
	})
	env := protocol.Envelope{
		V:         protocol.ContractVersion,
		Type:      protocol.TypeJoinRejected,
		RoomID:    roomID,
		RequestID: requestID,
		TS:        time.Now().UnixMilli(),
		Payload:   payload,
	}
	_ = conn.SendJSON(ctx, env)
}

// ---------------------------------------------------------------------
// presence — §§3.17, 3.18, §C.4
// ---------------------------------------------------------------------

// handleLeaveRoom implements §3.18.
func (s *Service) handleLeaveRoom(ctx context.Context, conn Conn, d *protocol.Decoded) error {
	if conn.State().PeerID == "" {
		s.writeError(ctx, conn, &protocol.ProtocolError{
			Code:    protocol.CodeNotInRoom,
			Message: "leave_room requires an admitted participant",
		}, d.Envelope.RequestID)
		return nil
	}
	s.releaseAndNotify(conn, "graceful_leave", protocol.RosterReasonGracefulLeave)
	conn.ClearJoined()
	_ = conn.CloseNormal("graceful_leave")
	return nil
}

// ReleaseAndNotify is the exported entry point for cleanup that
// crosses the package boundary. SessionMesh.OnDisconnect (in the
// mode root) calls it with reason="disconnect" after the read loop
// terminates. Inside the package, releaseAndNotify is the
// preferred name.
func (s *Service) ReleaseAndNotify(conn Conn, reason string, rosterReason protocol.RosterReason) {
	s.releaseAndNotify(conn, reason, rosterReason)
}

// releaseAndNotify is the canonical disconnect path (data-model §C.4).
// Frees the slot, broadcasts mesh_roster_update presence:left to any
// remaining participants, and (for in-call leavers — readiness >=
// media-ready at the moment of release) ALSO emits a `peer_left`
// envelope to remaining peers so each client can tear down its
// PairContext for the leaver via Path B (M12 / T092). Idempotent via
// conn.ReleaseOnce so the deferred ServeHTTP cleanup and an explicit
// leave_room don't double-emit.
//
// FR-025 / Path B isolation: the server MUST NOT broadcast a
// room-wide failed presence here. The leaver presence is `left`; each
// remaining client closes ONLY the pair local↔leaver, leaving healthy
// pairs alone.
func (s *Service) releaseAndNotify(conn Conn, reason string, rosterReason protocol.RosterReason) {
	state := conn.State()
	if state.PeerID == "" {
		return
	}
	// Atomically claim the cleanup. If a graceful leave_room and an
	// ungraceful disconnect race, only the first caller proceeds; the
	// second observes ReleaseOnce()=false and returns. Replaces the
	// pre-refactor `Released-check + Store(true)-after-Release` pattern
	// with a single CAS, closing the TOCTOU window.
	if !conn.ReleaseOnce() {
		return
	}
	// Snapshot the readiness BEFORE Release frees the slot (Release
	// drops the participant from the room's map so a post-release
	// lookup would return nil). Used to gate `peer_left` emission
	// below: only in-call leavers (media-ready) had pairs that need
	// teardown.
	departingReadiness := s.peerReadiness(state.RoomID, state.PeerID)
	outcome := s.Rooms.Release(state.RoomID, state.PeerID)
	if outcome.Departing == nil {
		return
	}
	rm := outcome.Room
	rm.Lock()
	update := buildRosterUpdate(rm, outcome.Departing, protocol.PresenceLeft, rosterReason)
	rm.Unlock()
	updatePayload, _ := json.Marshal(update)
	rosterEnv := protocol.Envelope{
		V:       protocol.ContractVersion,
		Type:    protocol.TypeMeshRosterUpdate,
		RoomID:  rm.ID(),
		TS:      time.Now().UnixMilli(),
		Payload: updatePayload,
	}

	// Build `peer_left` only for in-call leavers (readiness was
	// media-ready at the moment of release). A `joined`-state leaver
	// had no pairs yet, so the roster `left` update alone is enough.
	var peerLeftEnv *protocol.Envelope
	if departingReadiness == room.ReadinessMediaReady {
		peerLeftReason := protocol.PeerLeftDisconnect
		if rosterReason == protocol.RosterReasonGracefulLeave {
			peerLeftReason = protocol.PeerLeftGracefulLeave
		}
		peerLeftPayload, _ := json.Marshal(protocol.PeerLeftPayload{
			PeerID: outcome.Departing.PeerID,
			Reason: peerLeftReason,
		})
		peerLeftEnv = &protocol.Envelope{
			V:       protocol.ContractVersion,
			Type:    protocol.TypePeerLeft,
			RoomID:  rm.ID(),
			TS:      time.Now().UnixMilli(),
			Payload: peerLeftPayload,
		}
	}

	for _, p := range outcome.Remaining {
		if p.Conn == nil {
			continue
		}
		if err := p.Conn.SendJSON(p.Conn.BaseContext(), rosterEnv); err != nil {
			s.Log.Warn("mesh_roster_update send failed",
				slog.String("peer_id", p.PeerID),
				slog.String("error", err.Error()))
		}
		if peerLeftEnv != nil {
			if err := p.Conn.SendJSON(p.Conn.BaseContext(), *peerLeftEnv); err != nil {
				s.Log.Warn("peer_left send failed",
					slog.String("peer_id", p.PeerID),
					slog.String("error", err.Error()))
			}
		}
	}
	s.Log.Info("mesh peer departed",
		slog.String("event", "mesh_peer_departed"),
		slog.String("peer_id", state.PeerID),
		slog.String("room_id", state.RoomID),
		slog.String("reason", reason),
		slog.String("departing_readiness", string(departingReadiness)),
		slog.Bool("peer_left_emitted", peerLeftEnv != nil),
		slog.Bool("room_gc", outcome.RoomGarbageCollected),
	)
}

// peerReadiness returns the current readiness for the named participant
// or empty string when the room or participant is unknown. Caller must
// NOT hold the room mutex; the helper acquires it.
func (s *Service) peerReadiness(roomID, peerID string) room.Readiness {
	rm := s.Rooms.Room(roomID)
	if rm == nil {
		return ""
	}
	rm.Lock()
	defer rm.Unlock()
	p := rm.FindByPeerID(peerID)
	if p == nil {
		return ""
	}
	return p.Readiness
}

// ---------------------------------------------------------------------
// roster — §§3.4, 3.5
// ---------------------------------------------------------------------

// buildRosterSnapshot returns the §3.4 payload for the supplied room.
// Includes EVERY participant (subject + all others). Participants are
// sorted by admissionIndex ascending. Caller must hold the room lock.
//
// Presence values are derived from each participant's room.Readiness:
//
//	joined        → "joined"
//	media-ready   → "media-ready"
//	released      → "released"
//	left          → "left"
//
// `connecting` / `connected` / `failed` are per-(viewer, subject)
// values that the client derives locally from PairContext (data-model
// §A.6 note); the server emits them only via pair lifecycle messages,
// not via the roster snapshot.
func buildRosterSnapshot(r *room.Room) protocol.MeshRosterSnapshotPayload {
	parts := r.ParticipantsSnapshot()
	out := protocol.MeshRosterSnapshotPayload{
		ServerSeq:    r.NextRosterSeq(),
		Participants: make([]protocol.RosterParticipant, 0, len(parts)),
	}
	for _, p := range parts {
		out.Participants = append(out.Participants, protocol.RosterParticipant{
			PeerID:         p.PeerID,
			AdmissionIndex: p.AdmissionIndex,
			Presence:       presenceForReadiness(p.Readiness),
		})
	}
	return out
}

// buildRosterUpdate bumps the room's rosterSeq and returns the §3.5
// payload describing the change. Caller is responsible for fan-out
// to all participants. Caller must hold the room lock.
func buildRosterUpdate(r *room.Room, subject *room.Participant, presence protocol.Presence, reason protocol.RosterReason) protocol.MeshRosterUpdatePayload {
	seq := r.NextRosterSeq()
	return protocol.MeshRosterUpdatePayload{
		ServerSeq:      seq,
		SubjectPeerID:  subject.PeerID,
		AdmissionIndex: subject.AdmissionIndex,
		Presence:       presence,
		Reason:         reason,
	}
}

// presenceForReadiness maps the server-side room.Readiness FSM (§A.3)
// to the wire-level protocol.Presence enum used in roster messages.
func presenceForReadiness(r room.Readiness) protocol.Presence {
	switch r {
	case room.ReadinessJoined:
		return protocol.PresenceJoined
	case room.ReadinessMediaReady:
		return protocol.PresenceMediaReady
	case room.ReadinessReleased:
		return protocol.PresenceReleased
	case room.ReadinessLeft:
		return protocol.PresenceLeft
	}
	return protocol.PresenceJoined
}

// broadcastRosterUpdate fans out a single mesh_roster_update to ALL
// participants in the room (including the subject). Caller does NOT
// hold the room lock — this method takes and releases it internally.
func (s *Service) broadcastRosterUpdate(rm *room.Room, subject *room.Participant, presence protocol.Presence, reason protocol.RosterReason) {
	rm.Lock()
	update := buildRosterUpdate(rm, subject, presence, reason)
	targets := rm.ParticipantsSnapshot()
	rm.Unlock()
	payload, _ := json.Marshal(update)
	env := protocol.Envelope{
		V:       protocol.ContractVersion,
		Type:    protocol.TypeMeshRosterUpdate,
		RoomID:  rm.ID(),
		TS:      time.Now().UnixMilli(),
		Payload: payload,
	}
	for _, p := range targets {
		if p.Conn == nil {
			continue
		}
		if err := p.Conn.SendJSON(p.Conn.BaseContext(), env); err != nil {
			s.Log.Warn("mesh_roster_update send failed",
				slog.String("peer_id", p.PeerID),
				slog.String("error", err.Error()))
		}
	}
}

// ---------------------------------------------------------------------
// media — §§3.6, 3.7, 3.13
// ---------------------------------------------------------------------

// handleMediaReady implements §3.6. Transitions the participant
// readiness to media-ready and broadcasts the corresponding roster
// update. Per data-model §A.3, media_ready arriving from a non-`joined`
// readiness is rejected with `error { code: "unexpected_media_ready" }`.
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

// ---------------------------------------------------------------------
// pair_negotiation — §§3.9, 3.10, 3.11
// ---------------------------------------------------------------------

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

// ---------------------------------------------------------------------
// pair_trickle — §3.12
// ---------------------------------------------------------------------

// handlePairIceCandidate implements the §3.12 server-side relay path.
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

// ---------------------------------------------------------------------
// reconnect — §§3.14–3.16
// ---------------------------------------------------------------------

// handlePairFailed implements §3.16 — endpoint-detected failure
// relay. Mirrors the validation shape of relayPairIce but also flips
// the server-side Pair.State so a subsequent reconnect_pair can
// validate the failed precondition.
func (s *Service) handlePairFailed(ctx context.Context, conn Conn, d *protocol.Decoded) error {
	payload, ok := d.Message.(*protocol.PairFailedPayload)
	if !ok || payload == nil {
		s.writeError(ctx, conn, &protocol.ProtocolError{
			Code:    protocol.CodeInternalError,
			Message: "pair_failed decode mismatch",
		}, d.Envelope.RequestID)
		return nil
	}
	state := conn.State()
	if state.PeerID == "" || state.RoomID == "" {
		s.writeError(ctx, conn, &protocol.ProtocolError{
			Code:    protocol.CodeNotInRoom,
			Message: "pair_failed requires an admitted participant",
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
	pair, exists := ledger.Lookup(payload.PairID)
	if !exists {
		rm.Unlock()
		s.writeError(ctx, conn, &protocol.ProtocolError{
			Code:    protocol.CodeStalePairEpoch,
			Message: "pair " + payload.PairID + " is unknown to the server",
		}, d.Envelope.RequestID)
		return nil
	}
	senderIsLo := pair.LoPeerID == state.PeerID
	senderIsHi := pair.HiPeerID == state.PeerID
	if !senderIsLo && !senderIsHi {
		rm.Unlock()
		s.writeError(ctx, conn, &protocol.ProtocolError{
			Code:    protocol.CodeMalformed,
			Message: "sender does not belong to pair " + payload.PairID,
		}, d.Envelope.RequestID)
		return nil
	}
	if perr := protocol.ValidateStalePairEpoch(payload.PairID, payload.PairEpoch, ledger); perr != nil {
		rm.Unlock()
		s.writeError(ctx, conn, perr, d.Envelope.RequestID)
		return nil
	}
	pair.State = room.PairFailed
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
		s.Log.Info("pair_failed recipient absent",
			slog.String("event", "mesh_pair_failed_recipient_absent"),
			slog.String("room_id", roomID),
			slog.String("pair_id", payload.PairID),
		)
		return nil
	}

	envOut := protocol.Envelope{
		V:       protocol.ContractVersion,
		Type:    protocol.TypePairFailed,
		RoomID:  roomID,
		From:    state.PeerID,
		To:      recipientPeerID,
		TS:      time.Now().UnixMilli(),
		Payload: d.Envelope.Payload,
	}
	if err := recipient.Conn.SendJSON(recipient.Conn.BaseContext(), envOut); err != nil {
		s.Log.Warn("pair_failed forward failed",
			slog.String("event", "mesh_pair_failed_send_failed"),
			slog.String("pair_id", payload.PairID),
			slog.String("to", recipientPeerID),
			slog.String("error", err.Error()),
		)
		return nil
	}
	s.Log.Info("pair_failed forwarded",
		slog.String("event", "mesh_pair_failed_forwarded"),
		slog.String("room_id", roomID),
		slog.String("pair_id", payload.PairID),
		slog.Uint64("pair_epoch", payload.PairEpoch),
		slog.String("reason", string(payload.Reason)),
		slog.String("from", state.PeerID),
		slog.String("to", recipientPeerID),
	)
	return nil
}

// handleReconnectPair implements §3.14 — request a fresh attempt for
// one pair. Per-pair mutual exclusion is provided by the room mutex
// (the only path that mutates PairLedger); a simultaneous-click race
// resolves deterministically: one request acquires the lock first,
// validates observedEpoch == current, increments epoch, and emits
// pair_reconnect_instruction; the second request observes the
// already-incremented epoch and receives stale_pair_epoch.
func (s *Service) handleReconnectPair(ctx context.Context, conn Conn, d *protocol.Decoded) error {
	payload, ok := d.Message.(*protocol.ReconnectPairPayload)
	if !ok || payload == nil {
		s.writeError(ctx, conn, &protocol.ProtocolError{
			Code:    protocol.CodeInternalError,
			Message: "reconnect_pair decode mismatch",
		}, d.Envelope.RequestID)
		return nil
	}
	state := conn.State()
	if state.PeerID == "" || state.RoomID == "" {
		s.writeError(ctx, conn, &protocol.ProtocolError{
			Code:    protocol.CodeNotInRoom,
			Message: "reconnect_pair requires an admitted participant",
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
	pair, exists := ledger.Lookup(payload.PairID)
	if !exists {
		rm.Unlock()
		s.writeErrorWithContext(ctx, conn, &protocol.ProtocolError{
			Code:    protocol.CodeStalePairEpoch,
			Message: "pair " + payload.PairID + " is unknown to the server",
		}, d.Envelope.RequestID, map[string]any{
			"pairId":  payload.PairID,
			"subcode": "unknown_pair",
		})
		return nil
	}
	senderIsLo := pair.LoPeerID == state.PeerID
	senderIsHi := pair.HiPeerID == state.PeerID
	if !senderIsLo && !senderIsHi {
		rm.Unlock()
		s.writeErrorWithContext(ctx, conn, &protocol.ProtocolError{
			Code:    protocol.CodeMalformed,
			Message: "sender does not belong to pair " + payload.PairID,
		}, d.Envelope.RequestID, map[string]any{
			"pairId":  payload.PairID,
			"subcode": "not_pair_member",
		})
		return nil
	}
	// Order matters: validate observedEpoch BEFORE state. In a
	// simultaneous-click race the first request bumps the epoch AND
	// flips state to PairReconnecting; the loser observes BOTH the
	// new epoch AND the new state, but the canonical signal per
	// contract §3.14 is `stale_pair_epoch` (so both clients can
	// self-correct onto the winner's epoch). State-check first would
	// shadow the epoch signal with a misleading `pair_not_failed`.
	current, _ := ledger.CurrentPairEpoch(payload.PairID)
	if payload.ObservedEpoch != current {
		rm.Unlock()
		s.writeErrorWithContext(ctx, conn, &protocol.ProtocolError{
			Code:    protocol.CodeStalePairEpoch,
			Message: "reconnect_pair observedEpoch is stale; server is canonical",
		}, d.Envelope.RequestID, map[string]any{
			"pairId":   payload.PairID,
			"expected": current,
			"observed": payload.ObservedEpoch,
		})
		return nil
	}
	if pair.State != room.PairFailed {
		rm.Unlock()
		s.writeErrorWithContext(ctx, conn, &protocol.ProtocolError{
			Code:    protocol.CodeMalformed,
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
	// reconnect_pair, bumping the epoch here would corrupt the
	// ledger; refuse so the surviving peer self-corrects once it
	// processes the mesh_roster_update presence=left for the missing
	// endpoint.
	loPeer := rm.FindByPeerID(pair.LoPeerID)
	hiPeer := rm.FindByPeerID(pair.HiPeerID)
	if loPeer == nil || hiPeer == nil {
		rm.Unlock()
		s.writeErrorWithContext(ctx, conn, &protocol.ProtocolError{
			Code:    protocol.CodeNotInRoom,
			Message: "remote endpoint of pair " + payload.PairID + " is no longer in the room",
		}, d.Envelope.RequestID, map[string]any{
			"pairId":  payload.PairID,
			"subcode": "remote_left",
		})
		return nil
	}
	newEpoch, _ := ledger.Increment(payload.PairID)
	pair.State = room.PairReconnecting
	loIdx := loPeer.AdmissionIndex
	hiIdx := hiPeer.AdmissionIndex
	roomID := rm.ID()
	iceServers := s.ICE
	rm.Unlock()

	emitOne := func(recipient *room.Participant, role protocol.PairRole, remote *room.Participant, remoteIdx uint64) {
		if recipient == nil || recipient.Conn == nil || remote == nil {
			return
		}
		body, _ := json.Marshal(protocol.PairReconnectInstructionPayload{
			PairIdentity: protocol.PairIdentity{
				PairID:    payload.PairID,
				PairEpoch: newEpoch,
			},
			Role: role,
			RemotePeer: protocol.RemotePeerRef{
				PeerID:         remote.PeerID,
				AdmissionIndex: remoteIdx,
			},
			IceServers: iceServers,
		})
		env := protocol.Envelope{
			V:       protocol.ContractVersion,
			Type:    protocol.TypePairReconnectInstruction,
			RoomID:  roomID,
			To:      recipient.PeerID,
			TS:      time.Now().UnixMilli(),
			Payload: body,
		}
		if err := recipient.Conn.SendJSON(recipient.Conn.BaseContext(), env); err != nil {
			s.Log.Warn("pair_reconnect_instruction send failed",
				slog.String("event", "mesh_pair_reconnect_instruction_send_failed"),
				slog.String("pair_id", payload.PairID),
				slog.String("to", recipient.PeerID),
				slog.String("error", err.Error()),
			)
			return
		}
		s.Log.Info("pair_reconnect_instruction emitted",
			slog.String("event", "mesh_pair_reconnect_instruction_emitted"),
			slog.String("room_id", roomID),
			slog.String("pair_id", payload.PairID),
			slog.Uint64("pair_epoch", newEpoch),
			slog.String("role", string(role)),
			slog.String("to", recipient.PeerID),
		)
	}
	emitOne(loPeer, protocol.RoleOfferer, hiPeer, hiIdx)
	emitOne(hiPeer, protocol.RoleAnswerer, loPeer, loIdx)
	return nil
}

// writeErrorWithContext is the same as writeError but also includes
// the canonical `context` map (`pairId`, `expected`, etc.) per
// contract §3.19. Lets clients route a pair-scoped error back to the
// matching PairContext / button without parsing the message string.
func (s *Service) writeErrorWithContext(
	ctx context.Context,
	conn Conn,
	perr *protocol.ProtocolError,
	correlates string,
	context map[string]any,
) {
	if perr == nil {
		return
	}
	payload, _ := json.Marshal(protocol.ErrorPayload{
		Code:       perr.Code,
		Message:    perr.Message,
		Correlates: correlates,
		Context:    context,
	})
	env := protocol.Envelope{
		V:       protocol.ContractVersion,
		Type:    protocol.TypeError,
		TS:      time.Now().UnixMilli(),
		Payload: payload,
	}
	_ = conn.SendJSON(ctx, env)
}
