package room

import (
	"errors"
	"fmt"
	"sync"
	"time"
)

// MaxParticipants — hard 1:1 constraint (spec FR-002, Non-Goals).
const MaxParticipants = 2

// Participant mirrors data-model §A.3. The WS reference is stored as
// an opaque Conn to avoid importing coder/websocket here (that import
// lives in the handler layer and would otherwise create a cycle).
type Participant struct {
	PeerID         string
	RoomID         string
	AdmissionOrder int
	MediaReadiness MediaReadiness
	CallPhase      CallPhase
	Conn           Conn
	JoinedAt       time.Time
	LastSeen       time.Time
}

// Conn is the minimum surface the room package needs on the underlying
// WS connection. The handler layer supplies the real implementation.
//
// Implementations MUST be safe for concurrent use across SendJSON
// calls and WS reads.
type Conn interface {
	// SendJSON marshals v as a text frame and writes it to the peer.
	// Implementations are responsible for serializing writes.
	SendJSON(v any) error
}

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

// RolesAssigned returns whether ready_for_offer has been emitted for
// the current pairing. Reset to false on any slot release.
func (r *Room) RolesAssigned() bool { return r.rolesAssigned }

// SetRolesAssigned flips the rolesAssigned flag; Phase 4 flips it
// true, any Release flips it false (§A.2 invariant).
func (r *Room) SetRolesAssigned(v bool) { r.rolesAssigned = v }

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

// ---------------------------------------------------------------------
// T034A — stateful relay validation helpers
//
// These helpers implement the (role × mediaReadiness × callPhase)
// truth table from contract §§3.8–3.11 and data-model §C.2. They are
// intentionally layered BELOW the signaling package so the handler can
// call them without importing per-message envelope types — the helpers
// return a typed *RelayError carrying the wire `error.code` as a plain
// string, and the handler maps that string onto its ErrorCode enum.
//
// The helpers NEVER parse the message payload (SDP / ICE strings are
// opaque bytes at this layer — NFR-003); they validate purely against
// Room + Participant state plus the caller-supplied assigned role.
// ---------------------------------------------------------------------

// ParticipantRole is the role assigned to a participant for the
// current pairing attempt. Lower `AdmissionOrder` maps to RoleOfferer;
// the other slot is RoleAnswerer. If roles have not yet been assigned
// (or the peer is unknown), AssignedRole returns RoleNone.
type ParticipantRole string

const (
	RoleNone     ParticipantRole = ""
	RoleOfferer  ParticipantRole = "offerer"
	RoleAnswerer ParticipantRole = "answerer"
)

// Wire-level `error.code` strings returned by the relay validators.
// The signaling layer re-types these onto its ErrorCode enum; kept as
// plain strings here so the room package has no upward dependency.
const (
	RelayErrorUnexpectedOffer  = "unexpected_offer"
	RelayErrorUnexpectedAnswer = "unexpected_answer"
	RelayErrorMalformed        = "malformed"
	RelayErrorNotInRoom        = "not_in_room"
)

// RelayError is a typed, contract-aligned validation failure produced
// by the relay helpers. Code maps 1:1 onto the signaling `error.code`
// enum; Message is a short non-sensitive explanation suitable for
// forwarding to the client.
type RelayError struct {
	Code    string
	Message string
}

func (e *RelayError) Error() string {
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

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

// ResolveRemote returns the other participant relative to peerID.
// Alias for Remote() kept under a contract-aligned name so relay code
// in the handler reads closer to the protocol spec. Must be called
// under the room lock.
func (r *Room) ResolveRemote(peerID string) *Participant {
	return r.Remote(peerID)
}

// CanSendOffer enforces the three-field truth table for §3.8 `offer`
// at the sender state. Must be called under the room lock.
//
//   role           == offerer
//   mediaReadiness == ready
//   callPhase      == role-assigned  → accept (advance to negotiating)
//   callPhase      == negotiating    → reject (duplicate offer, EC-013)
//   anything else                    → reject (unexpected_offer)
//
// A duplicate offer is also routed to unexpected_offer — the EC-013
// glare guard: once the offerer has advanced past role-assigned for
// this pairing, further offers are protocol violations.
func (p *Participant) CanSendOffer(role ParticipantRole) *RelayError {
	if role != RoleOfferer {
		return &RelayError{
			Code:    RelayErrorUnexpectedOffer,
			Message: "sender is not the offerer for this pairing",
		}
	}
	if p.MediaReadiness != MediaReadinessReady {
		return &RelayError{
			Code:    RelayErrorUnexpectedOffer,
			Message: "sender is not media-ready",
		}
	}
	switch p.CallPhase {
	case CallPhaseRoleAssigned:
		return nil
	case CallPhaseNegotiating:
		return &RelayError{
			Code:    RelayErrorUnexpectedOffer,
			Message: "duplicate offer for the same pairing attempt",
		}
	default:
		return &RelayError{
			Code:    RelayErrorUnexpectedOffer,
			Message: "sender's callPhase does not permit offer",
		}
	}
}

// CanSendAnswer enforces the §3.9 truth table at the sender state.
// Must be called under the room lock.
//
//   role           == answerer
//   mediaReadiness == ready
//   callPhase      ∈ {role-assigned, negotiating}
func (p *Participant) CanSendAnswer(role ParticipantRole) *RelayError {
	if role != RoleAnswerer {
		return &RelayError{
			Code:    RelayErrorUnexpectedAnswer,
			Message: "sender is not the answerer for this pairing",
		}
	}
	if p.MediaReadiness != MediaReadinessReady {
		return &RelayError{
			Code:    RelayErrorUnexpectedAnswer,
			Message: "sender is not media-ready",
		}
	}
	switch p.CallPhase {
	case CallPhaseRoleAssigned, CallPhaseNegotiating:
		return nil
	default:
		return &RelayError{
			Code:    RelayErrorUnexpectedAnswer,
			Message: "sender's callPhase does not permit answer",
		}
	}
}

// CanSendIceCandidate enforces the §3.10 truth table. Role is not
// used (either peer may send trickle candidates). Must be called
// under the room lock.
//
// Wired into dispatch in Phase 8 (T063A). Helper exists in Phase 4
// (T034A) so the validation surface is complete and reusable.
func (p *Participant) CanSendIceCandidate(_ ParticipantRole) *RelayError {
	if p.MediaReadiness != MediaReadinessReady {
		return &RelayError{
			Code:    RelayErrorMalformed,
			Message: "sender is not media-ready",
		}
	}
	switch p.CallPhase {
	case CallPhaseRoleAssigned, CallPhaseNegotiating, CallPhaseConnected:
		return nil
	default:
		return &RelayError{
			Code:    RelayErrorMalformed,
			Message: "sender's callPhase does not permit ice_candidate",
		}
	}
}

// CanSendMediaState enforces the §3.11 truth table. Must be called
// under the room lock.
//
// Wired into dispatch in Phase 10 (T074A). Helper exists in Phase 4
// (T034A) so the validation surface is complete and reusable.
func (p *Participant) CanSendMediaState(_ ParticipantRole) *RelayError {
	if p.MediaReadiness != MediaReadinessReady {
		return &RelayError{
			Code:    RelayErrorMalformed,
			Message: "sender is not media-ready",
		}
	}
	switch p.CallPhase {
	case CallPhaseRoleAssigned, CallPhaseNegotiating, CallPhaseConnected:
		return nil
	default:
		return &RelayError{
			Code:    RelayErrorMalformed,
			Message: "sender's callPhase does not permit media_state",
		}
	}
}
