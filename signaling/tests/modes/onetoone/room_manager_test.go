package tests

import (
	"fmt"
	"math/rand"
	"sync"
	"sync/atomic"
	"testing"

	"webrtc-lab/signaling/internal/modes/onetoone/room"
)

// stubConn satisfies room.Conn without actually sending anything —
// suitable for RoomManager-level unit tests that don't exercise
// broadcast logic.
type stubConn struct{}

func (stubConn) SendJSON(_ any) error { return nil }

func newTestManagerWithSequentialIDs() *room.RoomManager {
	m := room.NewRoomManager()
	var n uint64
	m.SetPeerIDGenerator(func() string {
		return fmt.Sprintf("peer-%d", atomic.AddUint64(&n, 1))
	})
	return m
}

func TestAdmitAcceptsTwo(t *testing.T) {
	m := newTestManagerWithSequentialIDs()

	o1 := m.Admit("demo", stubConn{})
	if o1.Result != room.JoinAccepted {
		t.Fatalf("first admission: %q, want JoinAccepted", o1.Result)
	}
	if o1.Participant.AdmissionOrder != 1 {
		t.Fatalf("first admission order = %d, want 1", o1.Participant.AdmissionOrder)
	}

	o2 := m.Admit("demo", stubConn{})
	if o2.Result != room.JoinAccepted {
		t.Fatalf("second admission: %q, want JoinAccepted", o2.Result)
	}
	if o2.Participant.AdmissionOrder != 2 {
		t.Fatalf("second admission order = %d, want 2", o2.Participant.AdmissionOrder)
	}
}

func TestAdmitRejectsThirdWithRoomFull(t *testing.T) {
	m := newTestManagerWithSequentialIDs()
	m.Admit("demo", stubConn{})
	m.Admit("demo", stubConn{})

	o3 := m.Admit("demo", stubConn{})
	if o3.Result != room.JoinRejectedRoomFull {
		t.Fatalf("third admission: %q, want JoinRejectedRoomFull", o3.Result)
	}
	if o3.Participant != nil {
		t.Fatalf("rejected admission must not return a participant")
	}
}

func TestAdmitRejectsInvalidRoomID(t *testing.T) {
	m := newTestManagerWithSequentialIDs()

	for _, bad := range []string{"", "bad room", "a/b", "x!", "y:z"} {
		out := m.Admit(bad, stubConn{})
		if out.Result != room.JoinRejectedInvalidRoom {
			t.Errorf("Admit(%q) = %q, want JoinRejectedInvalidRoom", bad, out.Result)
		}
	}

	if rc := m.RoomCount(); rc != 0 {
		t.Errorf("invalid-ID admission created rooms: count=%d", rc)
	}
}

func TestReleaseGCsEmptyRoom(t *testing.T) {
	m := newTestManagerWithSequentialIDs()
	o := m.Admit("demo", stubConn{})
	if o.Result != room.JoinAccepted {
		t.Fatal("setup: admission failed")
	}
	if m.RoomCount() != 1 {
		t.Fatalf("expected 1 room after admit, got %d", m.RoomCount())
	}

	out := m.Release("demo", o.Participant.PeerID)
	if out.Departing == nil || out.Departing.PeerID != o.Participant.PeerID {
		t.Fatalf("release returned unexpected departing: %+v", out.Departing)
	}
	if !out.RoomGarbageCollected {
		t.Fatalf("expected room to be GC'd after last participant leaves")
	}
	if m.RoomCount() != 0 {
		t.Fatalf("room still present after GC: count=%d", m.RoomCount())
	}
}

func TestReleaseDoesNotRenumberRemaining(t *testing.T) {
	m := newTestManagerWithSequentialIDs()
	o1 := m.Admit("demo", stubConn{})
	o2 := m.Admit("demo", stubConn{})

	// Remove the first admitted participant; the second's
	// admissionOrder MUST remain 2 per §A.2 invariant
	// "a released slot does not renumber the remaining participant".
	rel := m.Release("demo", o1.Participant.PeerID)
	if rel.Remaining == nil {
		t.Fatal("expected a remaining participant")
	}
	if rel.Remaining.AdmissionOrder != 2 {
		t.Fatalf("remaining admissionOrder = %d, want 2 (no renumbering)",
			rel.Remaining.AdmissionOrder)
	}
	_ = o2
}

func TestRolesAssignedResetsOnRelease(t *testing.T) {
	m := newTestManagerWithSequentialIDs()
	o1 := m.Admit("demo", stubConn{})
	m.Admit("demo", stubConn{})

	// Simulate Phase 4's role assignment (flips rolesAssigned=true)
	// so we can verify Release resets it.
	rm := m.Room("demo")
	rm.Lock()
	rm.SetRolesAssigned(true)
	rm.Unlock()

	_ = m.Release("demo", o1.Participant.PeerID)

	rm.Lock()
	got := rm.RolesAssigned()
	rm.Unlock()

	if got {
		t.Fatalf("rolesAssigned still true after Release; §A.2 invariant violated")
	}
}

func TestCallReadinessDerivedStates(t *testing.T) {
	m := newTestManagerWithSequentialIDs()

	// empty (before any admit) — room doesn't exist yet, so this
	// check has to happen after the first admission. Admit participant 1.
	o1 := m.Admit("demo", stubConn{})

	rm := m.Room("demo")
	rm.Lock()
	cr := rm.CallReadiness()
	rm.Unlock()
	if cr != room.CallReadinessWaitingForMedia {
		t.Errorf("one pending-media participant: CallReadiness=%q, want waiting_for_media", cr)
	}

	// Flip the first to ready → waiting_for_peer.
	rm.Lock()
	o1.Participant.MediaReadiness = room.MediaReadinessReady
	cr = rm.CallReadiness()
	rm.Unlock()
	if cr != room.CallReadinessWaitingForPeer {
		t.Errorf("one ready participant: CallReadiness=%q, want waiting_for_peer", cr)
	}

	// Admit a second, still pending-media → waiting_for_media (any
	// non-ready participant keeps the room in waiting_for_media).
	o2 := m.Admit("demo", stubConn{})
	rm.Lock()
	cr = rm.CallReadiness()
	rm.Unlock()
	if cr != room.CallReadinessWaitingForMedia {
		t.Errorf("mixed ready/pending: CallReadiness=%q, want waiting_for_media", cr)
	}

	// Flip the second to ready → paired.
	rm.Lock()
	o2.Participant.MediaReadiness = room.MediaReadinessReady
	cr = rm.CallReadiness()
	rm.Unlock()
	if cr != room.CallReadinessPaired {
		t.Errorf("both ready: CallReadiness=%q, want paired", cr)
	}

	// After paired, release the first → dropping back to
	// waiting_for_peer (remaining participant still ready).
	_ = m.Release("demo", o1.Participant.PeerID)
	rm.Lock()
	cr = rm.CallReadiness()
	rm.Unlock()
	if cr != room.CallReadinessWaitingForPeer {
		t.Errorf("post-release: CallReadiness=%q, want waiting_for_peer", cr)
	}
}

// F1 regression — after slot reuse, admissionOrder still reports
// 1 or 2 (contract §3.2). Also locks in the invariant "released
// slot does not renumber the remaining participant" (data-model
// §A.2) across a long random sequence of admits / releases.
func TestAdmissionOrderStaysInSlotRange(t *testing.T) {
	m := newTestManagerWithSequentialIDs()

	// Explicit slot-reuse scenario from the F1 plan.
	a := m.Admit("demo", stubConn{})
	if a.Result != room.JoinAccepted || a.Participant.AdmissionOrder != 1 {
		t.Fatalf("A: result=%q order=%d want accepted order=1", a.Result, a.Participant.AdmissionOrder)
	}
	b := m.Admit("demo", stubConn{})
	if b.Result != room.JoinAccepted || b.Participant.AdmissionOrder != 2 {
		t.Fatalf("B: result=%q order=%d want accepted order=2", b.Result, b.Participant.AdmissionOrder)
	}

	_ = m.Release("demo", a.Participant.PeerID)

	c := m.Admit("demo", stubConn{})
	if c.Result != room.JoinAccepted {
		t.Fatalf("C (slot-reuse): result=%q want accepted", c.Result)
	}
	if c.Participant.AdmissionOrder != 1 {
		t.Fatalf("C took freed slot but order=%d; want 1 (slot-positional)",
			c.Participant.AdmissionOrder)
	}

	// B's order must not have been renumbered by the release.
	if b.Participant.AdmissionOrder != 2 {
		t.Fatalf("B renumbered after A's release: order=%d; want 2",
			b.Participant.AdmissionOrder)
	}

	// Long random sequence — every live participant must always have
	// order in {1, 2}.
	rng := rand.New(rand.NewSource(1))
	live := make([]*room.Participant, 0, 2)
	live = append(live, b.Participant, c.Participant)
	for i := 0; i < 500; i++ {
		switch rng.Intn(2) {
		case 0:
			// Try to admit. Expected: JoinAccepted if slot free, else
			// room_full.
			out := m.Admit("demo", stubConn{})
			if out.Result == room.JoinAccepted {
				if out.Participant.AdmissionOrder != 1 && out.Participant.AdmissionOrder != 2 {
					t.Fatalf("iter %d: admissionOrder=%d not in {1,2}",
						i, out.Participant.AdmissionOrder)
				}
				live = append(live, out.Participant)
			}
		case 1:
			// Try to release a random live participant.
			if len(live) == 0 {
				continue
			}
			idx := rng.Intn(len(live))
			_ = m.Release("demo", live[idx].PeerID)
			live = append(live[:idx], live[idx+1:]...)
		}
	}

	// Every remaining live participant's AdmissionOrder is still valid.
	for _, p := range live {
		if p.AdmissionOrder != 1 && p.AdmissionOrder != 2 {
			t.Fatalf("post-sequence: participant %s has admissionOrder %d",
				p.PeerID, p.AdmissionOrder)
		}
	}
}

// F4 regression — heavy concurrent Admit + Release traffic on the
// same room must not panic, must not leak rooms, and must stay
// race-clean under -race. This is the scenario that exposed the
// unlocked GC re-check in RoomManager.Release.
func TestConcurrentAdmitReleaseIsRaceFree(t *testing.T) {
	m := newTestManagerWithSequentialIDs()

	const iterations = 200
	const workers = 8

	var wg sync.WaitGroup
	wg.Add(workers)
	for w := 0; w < workers; w++ {
		go func() {
			defer wg.Done()
			for i := 0; i < iterations; i++ {
				out := m.Admit("shared", stubConn{})
				if out.Result == room.JoinAccepted {
					_ = m.Release("shared", out.Participant.PeerID)
				}
			}
		}()
	}
	wg.Wait()

	// After all workers exit, the room should be GC'd.
	if rc := m.RoomCount(); rc != 0 {
		t.Fatalf("expected no residual rooms; got %d", rc)
	}
}

func TestConcurrentAdmitsSerializeCorrectly(t *testing.T) {
	m := newTestManagerWithSequentialIDs()

	const n = 20
	results := make([]room.JoinResult, n)
	var wg sync.WaitGroup
	wg.Add(n)
	for i := 0; i < n; i++ {
		go func(i int) {
			defer wg.Done()
			out := m.Admit("demo", stubConn{})
			results[i] = out.Result
		}(i)
	}
	wg.Wait()

	accepted, full := 0, 0
	for _, r := range results {
		switch r {
		case room.JoinAccepted:
			accepted++
		case room.JoinRejectedRoomFull:
			full++
		}
	}
	if accepted != 2 {
		t.Fatalf("expected exactly 2 JoinAccepted, got %d (full=%d)", accepted, full)
	}
	if accepted+full != n {
		t.Fatalf("unexpected results: accepted=%d full=%d (total=%d)", accepted, full, n)
	}
}
