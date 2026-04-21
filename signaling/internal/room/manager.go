package room

import (
	"regexp"
	"sync"

	"github.com/google/uuid"
)

// RoomIDRegex mirrors the server-authoritative validator from the
// signaling contract §1. Kept here as well so the room package does
// not depend on the signaling package (which would be a layer
// violation).
var RoomIDRegex = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

// JoinResult is the canonical outcome enum from data-model §A.4 and
// the signaling contract §3.2/§3.3. The handler maps Admit's return
// value directly to the matching signaling message — this package
// does not format JSON.
type JoinResult string

const (
	JoinAccepted             JoinResult = "join_accepted"
	JoinRejectedRoomFull     JoinResult = "join_rejected_room_full"
	JoinRejectedInvalidRoom  JoinResult = "join_rejected_invalid_room"
)

// AdmissionOutcome carries everything the handler needs to reply to a
// join_room. Participant is non-nil only for Result == JoinAccepted.
type AdmissionOutcome struct {
	Result      JoinResult
	Participant *Participant
	Room        *Room
}

// ReleaseOutcome carries the data the handler needs after a
// participant leaves.
type ReleaseOutcome struct {
	// Departing is the participant that was just removed, captured
	// BEFORE the room mutation so the handler can classify an in-call
	// vs pre-pairing departure from its CallPhase.
	Departing *Participant
	// Remaining is the surviving participant in the room (if any) at
	// the moment of release.
	Remaining *Participant
	// RoomGarbageCollected is true if the room was the last reference
	// and has been removed from the manager's map.
	RoomGarbageCollected bool
}

// RoomManager is the top-level service (data-model §A.1). It holds
// all active rooms and mediates admission.
type RoomManager struct {
	mu    sync.Mutex
	rooms map[string]*Room

	// peerIDGen is overridable in tests. Defaults to uuid.NewString.
	peerIDGen func() string
}

// NewRoomManager constructs an empty manager.
func NewRoomManager() *RoomManager {
	return &RoomManager{
		rooms:     make(map[string]*Room),
		peerIDGen: uuid.NewString,
	}
}

// SetPeerIDGenerator replaces the peer-ID generator. Intended for
// tests — production code uses the UUIDv4 default.
func (m *RoomManager) SetPeerIDGenerator(gen func() string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.peerIDGen = gen
}

// RoomCount returns the number of live rooms.
func (m *RoomManager) RoomCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.rooms)
}

// Room returns the room with the given id, or nil if no such room
// exists.
func (m *RoomManager) Room(id string) *Room {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.rooms[id]
}

// Admit attempts to reserve a slot for the given WS connection in the
// room identified by roomID. The returned AdmissionOutcome captures
// both success and rejection branches; the handler translates it to
// the matching signaling message.
//
// Validation order matters:
//  1. Room ID regex (§A.1 invariants). Invalid IDs MUST be rejected
//     BEFORE a capacity check so a malformed ID can never create a
//     room.
//  2. Find or create the Room.
//  3. Attempt to add the participant; ErrRoomFull maps to
//     JoinRejectedRoomFull.
func (m *RoomManager) Admit(roomID string, conn Conn) AdmissionOutcome {
	if !RoomIDRegex.MatchString(roomID) {
		return AdmissionOutcome{Result: JoinRejectedInvalidRoom}
	}

	m.mu.Lock()
	rm, exists := m.rooms[roomID]
	if !exists {
		rm = NewRoom(roomID)
		m.rooms[roomID] = rm
	}
	m.mu.Unlock()

	// Generate the peer ID BEFORE acquiring rm.mu. generatePeerID
	// takes m.mu internally, and Release (F4 fix) nests m.mu outside
	// rm.mu. Calling generatePeerID while holding rm.mu would be the
	// inverse nesting and risks deadlock.
	peerID := m.generatePeerID()

	rm.Lock()
	p, err := rm.addParticipant(peerID, conn)
	rm.Unlock()

	if err != nil {
		// Only possible error here is ErrRoomFull per addParticipant.
		// If the room had JUST been created above we would not leave
		// an orphan: a fresh room is never full. So no GC is needed
		// here.
		return AdmissionOutcome{Result: JoinRejectedRoomFull, Room: rm}
	}

	return AdmissionOutcome{Result: JoinAccepted, Participant: p, Room: rm}
}

// Release removes the participant identified by peerID from the room
// and garbage-collects the room if it is now empty. Returns a
// ReleaseOutcome carrying both the departing and the remaining
// participant so the handler can broadcast the correct peer-presence
// change and, when appropriate, the convenience peer_left.
//
// Release is a no-op (Departing == nil) when the peer is not in the
// room — e.g., a double-leave or a disconnect after an explicit
// leave_room that already released the slot.
func (m *RoomManager) Release(roomID, peerID string) ReleaseOutcome {
	m.mu.Lock()
	rm, ok := m.rooms[roomID]
	m.mu.Unlock()
	if !ok {
		return ReleaseOutcome{}
	}

	rm.Lock()
	departing := rm.removeParticipant(peerID)
	var remaining *Participant
	if departing != nil {
		// Remaining participant at this moment (may be nil).
		parts := rm.Participants()
		if len(parts) > 0 {
			remaining = parts[0]
		}
	}
	empty := rm.IsEmpty()
	rm.Unlock()

	gc := false
	if empty {
		// Lock order m.mu (outer) → cur.mu (inner). Admit takes them
		// sequentially (m.mu then rm.mu, never nested) and the earlier
		// branch of Release takes rm.mu then m.mu (also sequential,
		// never nested), so this nested ordering introduces no
		// deadlock risk.
		m.mu.Lock()
		if cur, ok := m.rooms[roomID]; ok && cur == rm {
			cur.mu.Lock()
			stillEmpty := cur.IsEmpty()
			cur.mu.Unlock()
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
		RoomGarbageCollected: gc,
	}
}

func (m *RoomManager) generatePeerID() string {
	m.mu.Lock()
	gen := m.peerIDGen
	m.mu.Unlock()
	if gen == nil {
		gen = uuid.NewString
	}
	return gen()
}
