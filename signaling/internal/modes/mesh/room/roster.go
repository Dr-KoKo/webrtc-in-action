// Roster sequence (§A.6). Every emitted mesh_roster_snapshot and
// mesh_roster_update carries a monotonically-increasing
// `serverSeq`. The wire-payload construction itself lives in the
// signaling layer (specs/signaling-architecture.md §2.4 — wire ↔
// domain mapping lives only in signaling/); this file owns only the
// per-Room sequence counter.

package room

// NextRosterSeq advances rosterSeq and returns the new value.
// Caller must hold the lock. Used by every roster broadcast (§A.6)
// so the monotonic invariant holds across snapshots and updates.
func (r *Room) NextRosterSeq() uint64 {
	r.rosterSeq++
	return r.rosterSeq
}

// CurrentRosterSeq returns the most recently emitted serverSeq
// value (or 0 if no roster broadcast has been emitted yet). Caller
// must hold the lock.
func (r *Room) CurrentRosterSeq() uint64 { return r.rosterSeq }
