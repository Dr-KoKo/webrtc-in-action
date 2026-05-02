package signaling

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"webrtc-lab/signaling/internal/modes/mesh/protocol"
	"webrtc-lab/signaling/internal/modes/mesh/room"
)

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

// releaseAndNotify is the canonical disconnect path (data-model
// §C.4). Frees the slot, broadcasts mesh_roster_update presence:left
// to any remaining participants, and (for in-call leavers — readiness
// >= media-ready at the moment of release) ALSO emits a `peer_left`
// envelope to remaining peers so each client can tear down its
// PairContext for the leaver via Path B (M12 / T092). Idempotent via
// conn.ReleaseOnce so the deferred ServeHTTP cleanup and an explicit
// leave_room don't double-emit.
//
// FR-025 / Path B isolation: the server MUST NOT broadcast a
// room-wide failed presence here. The leaver presence is `left`;
// each remaining client closes ONLY the pair local↔leaver, leaving
// healthy pairs alone.
func (s *Service) releaseAndNotify(conn Conn, reason string, rosterReason protocol.RosterReason) {
	state := conn.State()
	if state.PeerID == "" {
		return
	}
	// Atomically claim the cleanup. If a graceful leave_room and an
	// ungraceful disconnect race, only the first caller proceeds; the
	// second observes ReleaseOnce()=false and returns. Replaces the
	// pre-refactor `Released-check + Store(true)-after-Release`
	// pattern with a single CAS, closing the TOCTOU window.
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

// peerReadiness returns the current readiness for the named
// participant or empty string when the room or participant is
// unknown. Caller must NOT hold the room mutex; the helper acquires
// it.
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
