// Roster snapshot + broadcast helpers (contract §3.4 + §3.5,
// FR-012a + FR-012b). Mirrors what was in mesh/roster.go before
// the redesign but lives next to the verbs so the wire conversion
// (presence enums, roster payloads) stays in the signaling layer
// (specs/signaling-architecture.md §2.4 — wire↔domain mapping
// lives only in signaling/).

package signaling

import (
	"encoding/json"
	"log/slog"
	"time"

	"webrtc-lab/signaling/internal/modes/mesh/protocol"
	"webrtc-lab/signaling/internal/modes/mesh/room"
)

// buildRosterSnapshot returns the §3.4 payload for the supplied
// room. Includes EVERY participant (subject + all others).
// Participants are sorted by admissionIndex ascending. Caller must
// hold the room lock.
//
// Presence values are derived from each participant's
// room.Readiness:
//
//	joined        → "joined"
//	media-ready   → "media-ready"
//	released      → "released"
//	left          → "left"
//
// `connecting` / `connected` / `failed` are per-(viewer, subject)
// values that the client derives locally from PairContext
// (data-model §A.6 note); the server emits them only via pair
// lifecycle messages, not via the roster snapshot.
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

// presenceForReadiness maps the server-side room.Readiness FSM
// (§A.3) to the wire-level protocol.Presence enum used in roster
// messages.
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
// hold the room lock — this method takes and releases it
// internally.
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
