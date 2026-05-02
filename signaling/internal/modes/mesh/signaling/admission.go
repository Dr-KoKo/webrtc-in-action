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
