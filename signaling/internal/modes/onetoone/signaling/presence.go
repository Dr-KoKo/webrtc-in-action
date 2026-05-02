package signaling

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"webrtc-lab/signaling/internal/modes/onetoone/protocol"
	"webrtc-lab/signaling/internal/modes/onetoone/room"
)

// handleLeaveRoom is contract §3.14: graceful client departure.
// Releases the slot, broadcasts to any remaining peer, and closes
// the WS with a normal-closure frame.
func (s *Service) handleLeaveRoom(ctx context.Context, conn Conn, d *protocol.Decoded) error {
	if conn.State().PeerID == "" {
		s.writeError(ctx, conn, &protocol.DecodeError{
			Code:    protocol.CodeNotInRoom,
			Message: "leave_room requires an admitted participant",
		}, d.Envelope.RequestID)
		return nil
	}

	s.releaseAndNotify(conn, "graceful_leave")

	// Contract §3.14 step 5: close the sender's WS. Clearing the
	// conn identifiers is defense-in-depth — the read loop exits on
	// the next Read anyway once the close frame is sent, and the
	// deferred ServeHTTP cleanup already guards against
	// double-release via the released latch.
	conn.ClearJoined()
	_ = conn.CloseNormal("graceful_leave")
	return nil
}

// departureClassification captures the §C.6 step-1 decision: was the
// departing peer in-call (role-assigned | negotiating | connected)
// or still pre-pairing (pending-media, or ready-but-not-paired). The
// same classification decides both the presence enum on the broadcast
// and whether the convenience peer_left message is sent.
type departureClassification struct {
	inCall         bool
	presence       protocol.Presence
	presenceReason protocol.PresenceReason
	peerLeftReason protocol.PeerLeftReason
}

// classifyDeparture runs §C.6 step 1 BEFORE any state mutation. The
// caller passes `reason ∈ {"graceful_leave", "disconnect",
// "media_failed"}` — reason drives the protocol.PresenceReason / protocol.PeerLeftReason
// labels but never overrides the in-call / pre-pairing split. A
// pending-media departure is ALWAYS pre-pairing regardless of reason,
// which is the invariant T086's
// `TestPendingMediaDisconnectDoesNotEmitPeerLeft` locks down.
func classifyDeparture(p *room.Participant, reason string) departureClassification {
	inCall := false
	if p != nil {
		inCall = room.IsInCall(p.CallPhase)
	}
	var presence protocol.Presence
	if inCall {
		presence = protocol.PresenceLeft
	} else {
		presence = protocol.PresenceReleased
	}
	var presReason protocol.PresenceReason
	switch reason {
	case "graceful_leave":
		presReason = protocol.PresenceReasonGracefulLeave
	case "disconnect":
		presReason = protocol.PresenceReasonDisconnect
	case "media_failed":
		presReason = protocol.PresenceReasonMediaFailed
	default:
		presReason = protocol.PresenceReasonDisconnect
	}
	var peerLeftReason protocol.PeerLeftReason
	if reason == "graceful_leave" {
		peerLeftReason = protocol.PeerLeftGracefulLeave
	} else {
		peerLeftReason = protocol.PeerLeftDisconnect
	}
	return departureClassification{
		inCall:         inCall,
		presence:       presence,
		presenceReason: presReason,
		peerLeftReason: peerLeftReason,
	}
}

// ReleaseAndNotify is the exported entry point for cleanup that
// crosses the package boundary. Session1to1.OnDisconnect (in the
// mode root) calls it with reason="disconnect" after the read loop
// terminates. Inside the package, releaseAndNotify is the
// preferred name.
func (s *Service) ReleaseAndNotify(conn Conn, reason string) {
	s.releaseAndNotify(conn, reason)
}

// releaseAndNotify runs the canonical server-side cleanup sequence
// from data-model §C.6 for a single departing participant. reason is
// "graceful_leave" (leave_room), "disconnect" (WS close / heartbeat
// pong timeout), or "media_failed" (post-admission media acquisition
// failure).
//
// Classification happens BEFORE the slot is mutated so the
// in-call-vs-pre-pairing decision is based on the participant's
// CallPhase at the moment of departure. Pending-media releases
// (media_failed, pending-media disconnect) are ALWAYS classified as
// pre-pairing and MUST NOT emit peer_left, even in Phase 4+.
func (s *Service) releaseAndNotify(conn Conn, reason string) {
	state := conn.State()
	roomID := state.RoomID
	peerID := state.PeerID

	// Snapshot the departing participant's state under the room lock
	// so classification is consistent with the release.
	rm := s.Rooms.Room(roomID)
	if rm == nil {
		conn.ReleaseOnce()
		return
	}

	rm.Lock()
	p := rm.FindByPeerID(peerID)
	cls := classifyDeparture(p, reason)
	rm.Unlock()

	outcome := s.Rooms.Release(roomID, peerID)
	conn.ReleaseOnce()

	if outcome.Departing == nil {
		// Either the slot was already gone (double-release race) or
		// the connection never successfully joined.
		return
	}

	if outcome.Remaining == nil {
		// No one to notify.
		return
	}

	// peer_presence_changed is ALWAYS sent on departure (§C.6 step 4).
	presencePayload, _ := json.Marshal(protocol.PeerPresenceChangedPayload{
		SubjectPeerID:  outcome.Departing.PeerID,
		AdmissionOrder: outcome.Departing.AdmissionOrder,
		Presence:       cls.presence,
		Reason:         cls.presenceReason,
	})
	presenceEnv := protocol.Envelope{
		V:       protocol.ContractVersion,
		Type:    protocol.TypePeerPresenceChanged,
		RoomID:  roomID,
		TS:      time.Now().UnixMilli(),
		Payload: presencePayload,
	}
	if err := outcome.Remaining.Conn.SendJSON(outcome.Remaining.Conn.BaseContext(), presenceEnv); err != nil {
		s.Log.Warn("peer_presence_changed send failed",
			slog.String("peer_id", outcome.Remaining.PeerID),
			slog.String("error", err.Error()))
	}

	// peer_left is ONLY sent for in-call departures (§C.6 step 5).
	// Pending-media releases use peer_presence_changed alone (§3.12
	// note: "Pending-media releases MUST NOT emit peer_left").
	if cls.inCall {
		payload, _ := json.Marshal(protocol.PeerLeftPayload{
			PeerID: outcome.Departing.PeerID,
			Reason: cls.peerLeftReason,
		})
		env := protocol.Envelope{
			V:       protocol.ContractVersion,
			Type:    protocol.TypePeerLeft,
			RoomID:  roomID,
			TS:      time.Now().UnixMilli(),
			Payload: payload,
		}
		if err := outcome.Remaining.Conn.SendJSON(outcome.Remaining.Conn.BaseContext(), env); err != nil {
			s.Log.Warn("peer_left send failed",
				slog.String("peer_id", outcome.Remaining.PeerID),
				slog.String("error", err.Error()))
		}
	}

	s.Log.Info("peer departed",
		slog.String("event", "peer_departed"),
		slog.String("peer_id", peerID),
		slog.String("room_id", roomID),
		slog.String("reason", reason),
		slog.Bool("in_call", cls.inCall),
		slog.Bool("room_gc", outcome.RoomGarbageCollected),
	)
}

// broadcastPresence sends peer_presence_changed to every reserved
// slot in the room (contract §3.4 "S→B to both reserved
// participants, including the subject").
func (s *Service) broadcastPresence(r *room.Room, subject *room.Participant, presence protocol.Presence, reason protocol.PresenceReason) {
	r.Lock()
	targets := r.Participants()
	r.Unlock()

	payload, _ := json.Marshal(protocol.PeerPresenceChangedPayload{
		SubjectPeerID:  subject.PeerID,
		AdmissionOrder: subject.AdmissionOrder,
		Presence:       presence,
		Reason:         reason,
	})
	env := protocol.Envelope{
		V:       protocol.ContractVersion,
		Type:    protocol.TypePeerPresenceChanged,
		RoomID:  subject.RoomID,
		TS:      time.Now().UnixMilli(),
		Payload: payload,
	}

	for _, p := range targets {
		if p.Conn == nil {
			continue
		}
		if err := p.Conn.SendJSON(p.Conn.BaseContext(), env); err != nil {
			s.Log.Warn("peer_presence_changed send failed",
				slog.String("peer_id", p.PeerID),
				slog.String("error", err.Error()))
		}
	}
}
