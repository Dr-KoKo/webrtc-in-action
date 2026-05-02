// MeshRoomManager — top-level mesh registry (data-model §A.1).
// Owns the map of MeshRoom keyed by roomId. Concurrent-safe via a
// manager-level mutex composed with each room's per-room mutex.
//
// Cross-mode separation: 001 has its own RoomManager in
// `internal/room/manager.go`. The two registries share NOTHING; a
// room ID may exist in both without collision (data-model §A.1
// "Invariants"). No code in this file imports the 001 package.

package mesh

import (
	"sync"

	"github.com/google/uuid"

	"webrtc-lab/signaling/internal/modes/mesh/protocol"
)

// AdmissionResult — the canonical admission outcome enum used by the
// handler to map onto the wire-level `join_accepted` /
// `join_rejected` channel.
type AdmissionResult string

const (
	JoinAccepted             AdmissionResult = "join_accepted"
	JoinRejectedRoomFullRes  AdmissionResult = "join_rejected_room_full"
	JoinRejectedInvalidRoom2 AdmissionResult = "join_rejected_invalid_room"
)

// AdmissionOutcome carries everything the handler needs to reply to a
// join_room. Participant + Room are non-nil only for JoinAccepted.
type AdmissionOutcome struct {
	Result      AdmissionResult
	Participant *Participant
	Room        *MeshRoom
}

// ReleaseOutcome carries the data the handler needs after a
// participant leaves.
type ReleaseOutcome struct {
	Departing            *Participant
	Remaining            []*Participant
	Room                 *MeshRoom
	RoomGarbageCollected bool
}

// ManagerConfig captures the static, env-derived configuration.
// IceServers is shared with the 001 server's iceServer list — both
// signaling endpoints read from the same VITE_STUN_URLS / VITE_TURN_*
// env keys (data-model §A.1 Config).
type ManagerConfig struct {
	IceServers []protocol.IceServer
}

// MeshRoomManager mirrors data-model §A.1.
type MeshRoomManager struct {
	mu        sync.Mutex
	rooms     map[string]*MeshRoom
	cfg       ManagerConfig
	peerIDGen func() string
}

// NewMeshRoomManager constructs an empty manager. Pass an empty
// ManagerConfig to use defaults (a single Google STUN entry).
func NewMeshRoomManager(cfg ManagerConfig) *MeshRoomManager {
	if len(cfg.IceServers) == 0 {
		cfg.IceServers = []protocol.IceServer{{URLs: []string{"stun:stun.l.google.com:19302"}}}
	}
	return &MeshRoomManager{
		rooms:     make(map[string]*MeshRoom),
		cfg:       cfg,
		peerIDGen: uuid.NewString,
	}
}

// SetPeerIDGenerator overrides the peer-ID generator. Tests use this
// for deterministic IDs.
func (m *MeshRoomManager) SetPeerIDGenerator(gen func() string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.peerIDGen = gen
}

// IceServers returns the shared ICE-server list (read-only snapshot).
func (m *MeshRoomManager) IceServers() []protocol.IceServer {
	out := make([]protocol.IceServer, len(m.cfg.IceServers))
	copy(out, m.cfg.IceServers)
	return out
}

// RoomCount returns the number of live mesh rooms (diagnostic).
func (m *MeshRoomManager) RoomCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.rooms)
}

// Room returns the existing MeshRoom for roomID or nil.
func (m *MeshRoomManager) Room(roomID string) *MeshRoom {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.rooms[roomID]
}

// JoinOrCreate validates roomID, fetches or constructs the matching
// MeshRoom, and admits the supplied connection. Returns one of the
// three AdmissionResult values per contract §3.1–§3.3.
//
// On successful admission the returned Outcome carries the
// freshly-created Participant (with peerID + admissionIndex) and the
// owning MeshRoom; the caller is responsible for emitting
// join_accepted + mesh_roster_snapshot + the broadcast roster update
// (handler.handleJoinRoom does this).
func (m *MeshRoomManager) JoinOrCreate(roomID string, conn Conn) AdmissionOutcome {
	if err := protocol.ValidateRoomID(roomID); err != nil {
		return AdmissionOutcome{Result: JoinRejectedInvalidRoom2}
	}

	m.mu.Lock()
	rm, ok := m.rooms[roomID]
	if !ok {
		rm = NewMeshRoom(roomID)
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
// returns the cleanup outcome. If the room becomes empty as a result,
// it is garbage-collected from the registry (data-model §A.1).
func (m *MeshRoomManager) Release(roomID, peerID string) ReleaseOutcome {
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
