// Room — one mesh room (data-model §A.2). Concurrent-safe via a
// single per-room mutex composed with the manager-level mutex for
// registry operations.
//
// Capacity invariant: 4 ReservedSlots. The 5th admission attempt
// returns ErrRoomFull, which the signaling layer maps to
// join_rejected { result: "join_rejected_room_full" } per contract
// §3.3.
//
// admissionCounter invariant: monotonic per Room, NEVER reused
// across the room's lifetime. A freed slot's index value is dropped;
// the next joiner gets a strictly-greater index. This guarantees
// `pairId` (derived from sorted admission indices) is unique across
// all pairs the room ever forms — research §5, plan §10.2.

package room

import (
	"errors"
	"sync"
	"time"
)

// MaxParticipants — hard cap from FR-011. Exposed for tests + audits
// (T101 grep target).
const MaxParticipants = 4

// SlotState — every slot is either free or reserved. Once reserved
// the slot's PeerID is set; once freed it returns to SlotFree and
// the PeerID is cleared. The slot Index is stable for the room's
// lifetime; admissionCounter (NOT slot.Index) is what derives pairId.
type SlotState int

const (
	SlotFree SlotState = iota
	SlotReserved
)

// ReservedSlot mirrors data-model §A.2.
type ReservedSlot struct {
	Index  uint8
	State  SlotState
	PeerID string
}

// ErrRoomFull is returned by Admit when all 4 slots are reserved.
var ErrRoomFull = errors.New("mesh room is full")

// Room mirrors data-model §A.2.
type Room struct {
	mu               sync.Mutex
	roomID           string
	slots            [MaxParticipants]ReservedSlot
	participants     map[string]*Participant // key: peerId
	admissionCounter uint64                  // monotonic; never reused
	pairs            *PairLedger
	rosterSeq        uint64
	createdAt        time.Time
}

// NewRoom constructs an empty Room. The slots' Index values are set
// to 0..3 once at construction.
func NewRoom(id string) *Room {
	r := &Room{
		roomID:       id,
		participants: make(map[string]*Participant),
		pairs:        newPairLedger(),
		createdAt:    time.Now(),
	}
	for i := range r.slots {
		r.slots[i] = ReservedSlot{Index: uint8(i), State: SlotFree}
	}
	return r
}

// ID returns the room identifier.
func (r *Room) ID() string { return r.roomID }

// CreatedAt returns the room's creation timestamp (diagnostic only).
func (r *Room) CreatedAt() time.Time { return r.createdAt }

// Lock / Unlock expose the room mutex so the signaling layer can
// compose multiple mutations (admit + snapshot + broadcast) inside
// one critical section without double-locking. Every method that
// mutates Room state assumes this lock is held by the caller.
func (r *Room) Lock()   { r.mu.Lock() }
func (r *Room) Unlock() { r.mu.Unlock() }

// ReservedCount counts the occupied slots. Caller must hold the lock.
func (r *Room) ReservedCount() int {
	n := 0
	for _, s := range r.slots {
		if s.State == SlotReserved {
			n++
		}
	}
	return n
}

// IsFull reports whether all 4 slots are reserved (regardless of
// readiness).
func (r *Room) IsFull() bool { return r.ReservedCount() == MaxParticipants }

// IsEmpty reports whether all slots are free.
func (r *Room) IsEmpty() bool { return r.ReservedCount() == 0 }

// Admit reserves the lowest-index free slot, allocates a fresh
// admissionIndex (= ++admissionCounter), and stores a Participant
// keyed by peerID. Returns ErrRoomFull when full. Caller must hold
// the lock.
func (r *Room) Admit(peerID string, conn Conn) (*Participant, error) {
	if r.IsFull() {
		return nil, ErrRoomFull
	}
	for i := range r.slots {
		if r.slots[i].State == SlotFree {
			r.admissionCounter++
			p := &Participant{
				PeerID:         peerID,
				AdmissionIndex: r.admissionCounter,
				Readiness:      ReadinessJoined,
				Conn:           conn,
				JoinedAt:       time.Now(),
				LastSeen:       time.Now(),
			}
			r.slots[i] = ReservedSlot{Index: uint8(i), State: SlotReserved, PeerID: peerID}
			r.participants[peerID] = p
			return p, nil
		}
	}
	return nil, ErrRoomFull
}

// Release frees the slot occupied by peerID and returns the removed
// Participant for classification (or nil if unknown). admissionIndex
// is NOT reused — the next Admit increments admissionCounter again.
// Caller must hold the lock.
func (r *Room) Release(peerID string) *Participant {
	p, ok := r.participants[peerID]
	if !ok {
		return nil
	}
	delete(r.participants, peerID)
	for i, s := range r.slots {
		if s.State == SlotReserved && s.PeerID == peerID {
			r.slots[i] = ReservedSlot{Index: uint8(i), State: SlotFree}
			break
		}
	}
	return p
}

// FindByPeerID returns the Participant with the given peerID or nil.
// Caller must hold the lock.
func (r *Room) FindByPeerID(peerID string) *Participant {
	return r.participants[peerID]
}

// ParticipantsSnapshot returns a fresh slice of all current
// participants in admissionIndex order. Caller must hold the lock.
func (r *Room) ParticipantsSnapshot() []*Participant {
	out := make([]*Participant, 0, len(r.participants))
	for _, p := range r.participants {
		out = append(out, p)
	}
	// Sort by admissionIndex ascending so callers (snapshot emission,
	// pair-id derivation) get stable output.
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j-1].AdmissionIndex > out[j].AdmissionIndex; j-- {
			out[j-1], out[j] = out[j], out[j-1]
		}
	}
	return out
}

// AdmissionCounter exposes the monotonic counter for tests
// (TestAdmissionIndexNeverReused). Caller must hold the lock.
func (r *Room) AdmissionCounter() uint64 { return r.admissionCounter }

// PairLedger returns the room's pair-epoch ledger. The concrete
// *PairLedger structurally satisfies the protocol.PairLedger
// interface — callers in the signaling layer can pass the result
// directly to protocol.ValidateStalePairEpoch without an explicit
// conversion. Caller must hold the lock when mutating; reads also
// need it under the room model's concurrency contract.
func (r *Room) PairLedger() *PairLedger { return r.pairs }

// nextRosterSeq advances rosterSeq and returns the new value. Caller
// must hold the lock. Used by every roster broadcast (§A.6) so the
// monotonic invariant holds across snapshots and updates.
func (r *Room) nextRosterSeq() uint64 {
	r.rosterSeq++
	return r.rosterSeq
}

// NextRosterSeq is the exported variant of nextRosterSeq, callable
// by the signaling layer (which lives in a sibling package).
func (r *Room) NextRosterSeq() uint64 { return r.nextRosterSeq() }

// CurrentRosterSeq returns the most recently emitted serverSeq value
// (or 0 if no roster broadcast has been emitted yet). Caller must
// hold the lock.
func (r *Room) CurrentRosterSeq() uint64 { return r.rosterSeq }
