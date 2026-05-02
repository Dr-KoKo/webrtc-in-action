package signaling

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"webrtc-lab/signaling/internal/modes/onetoone/protocol"
	"webrtc-lab/signaling/internal/modes/onetoone/room"
)

// handleJoinRoom is contract §3.1. The room manager returns one of
// {invalid_room, room_full, accepted}; the first two route to
// join_rejected (terminal admission outcome, NOT a generic error
// frame), the third proceeds to send join_accepted and broadcast
// peer_presence_changed (§3.2 + §3.4).
func (s *Service) handleJoinRoom(ctx context.Context, conn Conn, d *protocol.Decoded) error {
	if conn.State().PeerID != "" {
		s.writeError(ctx, conn, &protocol.DecodeError{
			Code:    protocol.CodeAlreadyJoined,
			Message: "this connection has already joined a room",
		}, d.Envelope.RequestID)
		return nil
	}

	roomID := d.Envelope.RoomID
	if err := protocol.ValidateRoomID(roomID); err != nil {
		// Contract §3.1 + §3.3 route invalid IDs to join_rejected, not
		// the generic `error` message, because it is a terminal
		// admission outcome not a protocol violation.
		s.sendJoinRejected(ctx, conn, roomID, d.Envelope.RequestID,
			protocol.JoinRejectedInvalidRoom, protocol.ReasonInvalidRoomID,
			"room ID must match ^[A-Za-z0-9._-]{1,64}$.")
		return nil
	}

	outcome := s.Rooms.Admit(roomID, conn)

	switch outcome.Result {
	case room.JoinRejectedInvalidRoom:
		s.sendJoinRejected(ctx, conn, roomID, d.Envelope.RequestID,
			protocol.JoinRejectedInvalidRoom, protocol.ReasonInvalidRoomID,
			"room ID must match ^[A-Za-z0-9._-]{1,64}$.")
		return nil

	case room.JoinRejectedRoomFull:
		s.sendJoinRejected(ctx, conn, roomID, d.Envelope.RequestID,
			protocol.JoinRejectedRoomFull, protocol.ReasonRoomFull,
			"Room '"+roomID+"' already has two reserved participants.")
		return nil

	case room.JoinAccepted:
		conn.MarkJoined(outcome.Participant.PeerID, outcome.Participant.RoomID)
	}

	// Snapshot the remote peer (if any) under the room lock so the
	// join_accepted payload reflects the state at admission time.
	outcome.Room.Lock()
	var remote *protocol.RemotePeerSnapshot
	if r := outcome.Room.Remote(outcome.Participant.PeerID); r != nil {
		remote = &protocol.RemotePeerSnapshot{
			PeerID:         r.PeerID,
			MediaReadiness: toWireMediaReadiness(r.MediaReadiness),
		}
	}
	readiness := toWireRoomReadiness(outcome.Room.CallReadiness())
	admissionOrder := outcome.Participant.AdmissionOrder
	outcome.Room.Unlock()

	payload, _ := json.Marshal(protocol.JoinAcceptedPayload{
		PeerID:         outcome.Participant.PeerID,
		AdmissionOrder: admissionOrder,
		RoomReadiness:  readiness,
		RemotePeer:     remote,
	})
	env := protocol.Envelope{
		V:         protocol.ContractVersion,
		Type:      protocol.TypeJoinAccepted,
		RoomID:    roomID,
		RequestID: d.Envelope.RequestID,
		TS:        time.Now().UnixMilli(),
		Payload:   payload,
	}
	if err := conn.SendJSON(ctx, env); err != nil {
		s.Log.Warn("join_accepted send failed",
			slog.String("conn_id", conn.ID()), slog.String("error", err.Error()))
	}

	// Broadcast the admission event to both reserved participants (§3.4,
	// §T025 DoD — including the subject).
	s.broadcastPresence(outcome.Room, outcome.Participant,
		protocol.PresencePendingMedia, protocol.PresenceReasonAdmitted)

	state := conn.State()
	s.Log.Info("peer admitted",
		slog.String("event", "peer_admitted"),
		slog.String("conn_id", conn.ID()),
		slog.String("peer_id", state.PeerID),
		slog.String("room_id", state.RoomID),
		slog.Int("admission_order", admissionOrder),
	)
	return nil
}

// sendJoinRejected centralizes the join_rejected send so both the
// pre-admit room-ID validator and the RoomManager rejection paths use
// the same envelope shape.
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
// room → wire enum mapping
//
// Wire↔domain conversion lives only in this package per
// specs/signaling-architecture.md §2.4. Kept next to handleJoinRoom
// because that is currently the only verb that maps room enums onto
// wire enums; future verbs that need the conversion can pull these
// helpers up to a wiremap.go file.
// ---------------------------------------------------------------------

func toWireMediaReadiness(m room.MediaReadiness) protocol.MediaReadiness {
	switch m {
	case room.MediaReadinessReady:
		return protocol.MediaReady
	}
	return protocol.MediaPending
}

func toWireRoomReadiness(c room.CallReadiness) protocol.RoomReadiness {
	switch c {
	case room.CallReadinessEmpty:
		return protocol.RoomEmpty
	case room.CallReadinessWaitingForMedia:
		return protocol.RoomWaitingForMedia
	case room.CallReadinessWaitingForPeer:
		return protocol.RoomWaitingForPeer
	case room.CallReadinessPaired:
		return protocol.RoomPaired
	}
	return protocol.RoomEmpty
}
