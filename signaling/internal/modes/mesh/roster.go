// Roster snapshot + broadcast helpers (contract §3.4 + §3.5,
// FR-012a + FR-012b). Caller composes these with handler-level
// machinery; both helpers assume the room lock is HELD on entry.

package mesh

// BuildRosterSnapshot returns the §3.4 payload for the supplied room.
// Includes EVERY participant (subject + all others). Participants are
// sorted by admissionIndex ascending.
//
// Presence values are derived from each participant's Readiness:
//   joined        → "joined"
//   media-ready   → "media-ready"
//   released      → "released"
//   left          → "left"
//
// `connecting` / `connected` / `failed` are per-(viewer, subject)
// values that the client derives locally from PairContext (data-model
// §A.6 note); the server emits them only via pair lifecycle messages,
// not via the roster snapshot.
//
// The snapshot bumps `rosterSeq` so its emitted seq is strictly
// greater than any prior emission. Subsequent `mesh_roster_update`
// broadcasts continue to bump and remain strictly greater than the
// snapshot — closing the §3.4 ambiguity around "most recent emitted
// value at the time of admission" by treating the snapshot itself as
// a fresh emission. Today the client roster reducer's REPLACE
// semantic on snapshot already neutralizes the ambiguity, but this
// keeps the wire shape unambiguous regardless of client behavior.
//
// Caller must hold the room lock.
func BuildRosterSnapshot(r *MeshRoom) MeshRosterSnapshotPayload {
	parts := r.ParticipantsSnapshot()
	out := MeshRosterSnapshotPayload{
		ServerSeq:    r.nextRosterSeq(),
		Participants: make([]RosterParticipant, 0, len(parts)),
	}
	for _, p := range parts {
		out.Participants = append(out.Participants, RosterParticipant{
			PeerID:         p.PeerID,
			AdmissionIndex: p.AdmissionIndex,
			Presence:       presenceForReadiness(p.Readiness),
		})
	}
	return out
}

// BuildRosterUpdate bumps the room's rosterSeq and returns the §3.5
// payload describing the change. The handler is responsible for
// fan-out to all participants via FanOutRoster.
//
// Caller must hold the room lock.
func BuildRosterUpdate(r *MeshRoom, subject *Participant, presence Presence, reason RosterReason) MeshRosterUpdatePayload {
	seq := r.nextRosterSeq()
	return MeshRosterUpdatePayload{
		ServerSeq:      seq,
		SubjectPeerID:  subject.PeerID,
		AdmissionIndex: subject.AdmissionIndex,
		Presence:       presence,
		Reason:         reason,
	}
}

// presenceForReadiness maps the server-side Readiness FSM (§A.3) to
// the wire-level Presence enum used in roster messages.
func presenceForReadiness(r Readiness) Presence {
	switch r {
	case ReadinessJoined:
		return PresenceJoined
	case ReadinessMediaReady:
		return PresenceMediaReady
	case ReadinessReleased:
		return PresenceReleased
	case ReadinessLeft:
		return PresenceLeft
	}
	return PresenceJoined
}
