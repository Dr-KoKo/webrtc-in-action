// RoomManager — top-level mesh registry (data-model §A.1). Owns
// the map of Room keyed by roomId. Concurrent-safe via a manager-
// level mutex composed with each room's per-room mutex.
//
// Cross-mode separation: 001 has its own RoomManager in
// internal/modes/onetoone/room. The two registries share NOTHING; a
// room ID may exist in both without collision (data-model §A.1
// "Invariants"). No code in this file imports the 001 package.
//
// Validation discipline: the room-ID format check
// (protocol.ValidateRoomID) is performed by the signaling layer
// BEFORE calling JoinOrCreate — the room manager only sees valid
// IDs. ICE-server config likewise lives outside (on
// signaling.Service / mesh.Handler), not on the manager.

package room

import (
	"sync"

	"github.com/google/uuid"
)

// AdmissionResult — the canonical admission outcome enum used by
// the signaling layer to map onto the wire-level join_accepted /
// join_rejected channel.
type AdmissionResult string

const (
	JoinAccepted            AdmissionResult = "join_accepted"
	JoinRejectedRoomFullRes AdmissionResult = "join_rejected_room_full"
)

// AdmissionOutcome carries everything the signaling layer needs to
// reply to a join_room. Participant + Room are non-nil only for
// JoinAccepted.
type AdmissionOutcome struct {
	Result      AdmissionResult
	Participant *Participant
	Room        *Room
}

// ReleaseOutcome carries the data the signaling layer needs after a
// participant leaves.
type ReleaseOutcome struct {
	Departing            *Participant
	Remaining            []*Participant
	Room                 *Room
	RoomGarbageCollected bool
}

// RoomManager mirrors data-model §A.1.
type RoomManager struct {
	mu        sync.Mutex
	rooms     map[string]*Room
	peerIDGen func() string
}

// NewRoomManager constructs an empty manager.
func NewRoomManager() *RoomManager {
	return &RoomManager{
		rooms:     make(map[string]*Room),
		peerIDGen: uuid.NewString,
	}
}

// SetPeerIDGenerator overrides the peer-ID generator. Tests use
// this for deterministic IDs.
func (m *RoomManager) SetPeerIDGenerator(gen func() string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.peerIDGen = gen
}

// RoomCount returns the number of live mesh rooms (diagnostic).
func (m *RoomManager) RoomCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.rooms)
}

// Room returns the existing Room for roomID or nil.
func (m *RoomManager) Room(roomID string) *Room {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.rooms[roomID]
}

// JoinOrCreate fetches or constructs the matching Room and admits
// the supplied connection. Returns either JoinAccepted or
// JoinRejectedRoomFullRes per contract §3.2/§3.3. The caller MUST
// have validated roomID format (e.g. via protocol.ValidateRoomID)
// before calling — this method assumes a valid ID.
//
// On successful admission the returned AdmissionOutcome carries the
// freshly-created Participant (with peerID + admissionIndex) and
// the owning Room; the caller is responsible for emitting
// join_accepted + mesh_roster_snapshot + the broadcast roster
// update.
func (m *RoomManager) JoinOrCreate(roomID string, conn Conn) AdmissionOutcome {
	m.mu.Lock()
	rm, ok := m.rooms[roomID]
	if !ok {
		rm = NewRoom(roomID)
		m.rooms[roomID] = rm
	}
	gen := m.peerIDGen
	m.mu.Unlock()

	rm.Lock()
	defer rm.Unlock()

	if rm.IsFull() {
		return AdmissionOutcome{Result: JoinRejectedRoomFullRes, Room: rm}
	}
	peerID := gen()
	p, err := rm.Admit(peerID, conn)
	if err != nil {
		// Race: another goroutine filled the last slot between our
		// IsFull() check and Admit(). Map back to room_full.
		return AdmissionOutcome{Result: JoinRejectedRoomFullRes, Room: rm}
	}
	return AdmissionOutcome{Result: JoinAccepted, Participant: p, Room: rm}
}

// Release frees the slot occupied by peerID in the named room and
// returns the cleanup outcome. If the room becomes empty as a
// result, it is garbage-collected from the registry (data-model
// §A.1).
func (m *RoomManager) Release(roomID, peerID string) ReleaseOutcome {
	m.mu.Lock()
	rm, ok := m.rooms[roomID]
	m.mu.Unlock()
	if !ok {
		return ReleaseOutcome{}
	}

	rm.Lock()
	departing := rm.Release(peerID)
	remaining := rm.ParticipantsSnapshot()
	empty := rm.IsEmpty()
	rm.Unlock()

	gc := false
	if empty {
		m.mu.Lock()
		// Re-check under the manager lock to avoid racing with a fresh
		// JoinOrCreate that might already have re-populated the room.
		if cur, ok := m.rooms[roomID]; ok && cur == rm {
			cur.Lock()
			stillEmpty := cur.IsEmpty()
			cur.Unlock()
			if stillEmpty {
				delete(m.rooms, roomID)
				gc = true
			}
		}
		m.mu.Unlock()
	}

	return ReleaseOutcome{
		Departing:            departing,
		Remaining:            remaining,
		Room:                 rm,
		RoomGarbageCollected: gc,
	}
}
