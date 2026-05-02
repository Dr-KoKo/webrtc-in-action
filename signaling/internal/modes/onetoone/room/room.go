package room

import (
	"errors"
	"sync"
	"time"
)

// MaxParticipants — hard 1:1 constraint (spec FR-002, Non-Goals).
const MaxParticipants = 2

// CallReadiness — derived room state from data-model §A.2.
type CallReadiness string

const (
	CallReadinessEmpty           CallReadiness = "empty"
	CallReadinessWaitingForMedia CallReadiness = "waiting_for_media"
	CallReadinessWaitingForPeer  CallReadiness = "waiting_for_peer"
	CallReadinessPaired          CallReadiness = "paired"
)

// Room mirrors data-model §A.2.
//
// Note on admissionOrder: it is the 1-based SLOT INDEX the
// participant occupies, NOT a monotonic counter. This matches the
// canonical contract §3.2 (payload schema `1 | 2`) and keeps the
// data-model §A.2 invariant "a released slot does not renumber the
// remaining participant" satisfied — the surviving peer keeps its
// order, and a new joiner takes the free slot's index. A monotonic
// counter would produce admissionOrder=3 after a single slot reuse,
// which the Zod and Go validators both reject.
type Room struct {
	id            string
	slots         [MaxParticipants]*Participant
	rolesAssigned bool
	createdAt     time.Time

	mu sync.Mutex
}

// NewRoom constructs an empty Room. Use RoomManager.Admit in
// production code — this is exported only for tests.
func NewRoom(id string) *Room {
	return &Room{id: id, createdAt: time.Now()}
}

// ID returns the room identifier.
func (r *Room) ID() string { return r.id }

// CreatedAt returns the room's creation timestamp (diagnostic only).
func (r *Room) CreatedAt() time.Time { return r.createdAt }

// Lock / Unlock expose the room mutex so the handler can compose
// multiple mutations (e.g., admit + broadcast) inside one critical
// section without double-locking. All room-scoped mutations MUST hold
// this lock.
func (r *Room) Lock()   { r.mu.Lock() }
func (r *Room) Unlock() { r.mu.Unlock() }

// ReservedCount returns the number of occupied slots. Must be called
// under the room lock. Safe when exported because handlers always
// wrap it in Lock/Unlock.
func (r *Room) ReservedCount() int {
	n := 0
	for _, p := range r.slots {
		if p != nil {
			n++
		}
	}
	return n
}

// IsEmpty reports whether all slots are nil.
func (r *Room) IsEmpty() bool { return r.ReservedCount() == 0 }

// IsFull reports whether both slots are reserved (regardless of media
// readiness or call phase). Admission capacity is based on slot
// occupancy, not on derived call-readiness — §A.2 "Invariants".
func (r *Room) IsFull() bool { return r.ReservedCount() == MaxParticipants }

// Participants returns a snapshot of the non-nil slots in slot order.
// The returned slice is a fresh copy; mutating it does not affect
// Room state.
func (r *Room) Participants() []*Participant {
	out := make([]*Participant, 0, MaxParticipants)
	for _, p := range r.slots {
		if p != nil {
			out = append(out, p)
		}
	}
	return out
}

// FindByPeerID returns the participant with the given peerID or nil.
// Must be called under the room lock.
func (r *Room) FindByPeerID(peerID string) *Participant {
	for _, p := range r.slots {
		if p != nil && p.PeerID == peerID {
			return p
		}
	}
	return nil
}

// Remote returns the "other" participant relative to the given
// peerID. nil if no other participant or the given peerID is unknown.
func (r *Room) Remote(peerID string) *Participant {
	for _, p := range r.slots {
		if p != nil && p.PeerID != peerID {
			return p
		}
	}
	return nil
}

// ResolveRemote returns the other participant relative to peerID.
// Alias for Remote() kept under a contract-aligned name so relay code
// in the signaling layer reads closer to the protocol spec. Must be
// called under the room lock.
func (r *Room) ResolveRemote(peerID string) *Participant {
	return r.Remote(peerID)
}

// RolesAssigned returns whether ready_for_offer has been emitted for
// the current pairing. Reset to false on any slot release.
func (r *Room) RolesAssigned() bool { return r.rolesAssigned }

// SetRolesAssigned flips the rolesAssigned flag; Phase 4 flips it
// true, any Release flips it false (§A.2 invariant).
func (r *Room) SetRolesAssigned(v bool) { r.rolesAssigned = v }

// AssignedRole returns the pairing role for peerID using the rule
// "lower admissionOrder is offerer" (contract §3.7, §C.1). Unknown
// peerID returns RoleNone. Must be called under the room lock.
func (r *Room) AssignedRole(peerID string) ParticipantRole {
	var lowest *Participant
	var target *Participant
	for _, p := range r.slots {
		if p == nil {
			continue
		}
		if p.PeerID == peerID {
			target = p
		}
		if lowest == nil || p.AdmissionOrder < lowest.AdmissionOrder {
			lowest = p
		}
	}
	if target == nil {
		return RoleNone
	}
	if lowest != nil && target.PeerID == lowest.PeerID {
		return RoleOfferer
	}
	return RoleAnswerer
}

// ErrRoomFull is returned by addParticipant when both slots are
// occupied. RoomManager.Admit maps this to the canonical
// join_rejected_room_full result.
var ErrRoomFull = errors.New("room is full")

// addParticipant picks the lowest-index free slot, stamps the
// participant's AdmissionOrder = slotIndex + 1, and returns the
// new participant. The slot-positional scheme keeps AdmissionOrder
// bounded to {1, 2} per contract §3.2 even after slot reuse. Must
// be called under the room lock.
func (r *Room) addParticipant(peerID string, conn Conn) (*Participant, error) {
	for i := range r.slots {
		if r.slots[i] == nil {
			p := &Participant{
				PeerID:         peerID,
				RoomID:         r.id,
				AdmissionOrder: i + 1,
				MediaReadiness: MediaReadinessPending,
				CallPhase:      CallPhaseIdle,
				Conn:           conn,
				JoinedAt:       time.Now(),
				LastSeen:       time.Now(),
			}
			r.slots[i] = p
			return p, nil
		}
	}
	return nil, ErrRoomFull
}

// removeParticipant clears the slot occupied by peerID and returns the
// participant that was removed (for classification). Resets
// rolesAssigned to false per §A.2 invariant. Must be called under the
// room lock.
func (r *Room) removeParticipant(peerID string) *Participant {
	for i, p := range r.slots {
		if p != nil && p.PeerID == peerID {
			r.slots[i] = nil
			r.rolesAssigned = false
			return p
		}
	}
	return nil
}

// CallReadiness computes the derived call-readiness per data-model
// §A.2. Must be called under the room lock.
func (r *Room) CallReadiness() CallReadiness {
	reserved := r.ReservedCount()
	if reserved == 0 {
		return CallReadinessEmpty
	}

	allReady := true
	for _, p := range r.slots {
		if p != nil && p.MediaReadiness != MediaReadinessReady {
			allReady = false
			break
		}
	}

	if !allReady {
		return CallReadinessWaitingForMedia
	}

	if reserved < MaxParticipants {
		// Exactly one slot, media-ready, waiting for a second joiner.
		return CallReadinessWaitingForPeer
	}

	return CallReadinessPaired
}
