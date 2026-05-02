// Package room implements the server-side participant / room model
// from data-model.md Part A. The public surface is split across:
//
//   - participant.go — Participant struct + MediaReadiness +
//     CallPhase enums (the two orthogonal state machines that
//     together describe a Participant), AdvanceMedia / AdvanceCall
//     transition validators, IsInCall classifier.
//   - fsm.go         — relay validators (CanSendOffer / Answer /
//     IceCandidate / MediaState), ParticipantRole, RelayError.
//   - room.go        — Room (two reserved slots) + derived
//     CallReadiness.
//   - manager.go     — RoomManager (admit / release; concurrent-safe).
//   - conn.go        — Conn interface (write surface).

package room

import "time"

// Participant mirrors data-model §A.3. The WS reference is stored as
// an opaque Conn to avoid importing coder/websocket here (that import
// lives in the mode root and would otherwise create a cycle).
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

// MediaReadiness — data-model §A.3 first enum.
type MediaReadiness string

const (
	MediaReadinessPending MediaReadiness = "pending-media"
	MediaReadinessReady   MediaReadiness = "ready"
	MediaReadinessFailed  MediaReadiness = "failed"
)

// CallPhase — data-model §A.3 second enum. Only meaningful while
// MediaReadiness == Ready.
type CallPhase string

const (
	CallPhaseIdle         CallPhase = "idle"
	CallPhaseRoleAssigned CallPhase = "role-assigned"
	CallPhaseNegotiating  CallPhase = "negotiating"
	CallPhaseConnected    CallPhase = "connected"
	CallPhaseLeaving      CallPhase = "leaving"
)

// AdvanceMedia returns true if the MediaReadiness transition from→to
// is permitted by the state machine in data-model §A.3. Unknown
// transitions are rejected.
//
// Permitted arrows (diagram from data-model):
//
//	pending-media -> ready
//	pending-media -> failed
//
// ready and failed are terminal w.r.t. the Participant's lifetime —
// both lead to slot release, not a transition to another enum value.
func AdvanceMedia(from, to MediaReadiness) bool {
	if from == to {
		// A "same-state" transition is a no-op, not an error. Callers
		// generally check Participant.mediaReadiness before dispatching,
		// so returning true here keeps the helper useful for idempotent
		// re-broadcasts.
		return true
	}
	switch from {
	case MediaReadinessPending:
		return to == MediaReadinessReady || to == MediaReadinessFailed
	}
	return false
}

// AdvanceCall returns true if the CallPhase transition is permitted
// while mediaReadiness == ready (data-model §A.3 second diagram).
//
// Permitted arrows:
//
//	idle           -> role-assigned
//	role-assigned  -> negotiating | leaving
//	negotiating    -> connected | leaving
//	connected      -> idle  (remote peer_left; local stays media-ready)
//	connected      -> leaving
//
// Any other transition is rejected.
func AdvanceCall(from, to CallPhase) bool {
	if from == to {
		return true
	}
	switch from {
	case CallPhaseIdle:
		return to == CallPhaseRoleAssigned
	case CallPhaseRoleAssigned:
		return to == CallPhaseNegotiating || to == CallPhaseLeaving
	case CallPhaseNegotiating:
		return to == CallPhaseConnected || to == CallPhaseLeaving
	case CallPhaseConnected:
		return to == CallPhaseIdle || to == CallPhaseLeaving
	case CallPhaseLeaving:
		return false
	}
	return false
}

// IsInCall returns true when the CallPhase corresponds to an active
// call-side lifecycle (the phase classification data-model §C.6 uses
// to decide whether to fire the convenience `peer_left` message).
//
// A participant is "in-call" once `ready_for_offer` has been
// delivered (role-assigned), and stays so through negotiating and
// connected. Pre-pairing states (idle after role release) and
// leaving are NOT in-call.
func IsInCall(phase CallPhase) bool {
	switch phase {
	case CallPhaseRoleAssigned, CallPhaseNegotiating, CallPhaseConnected:
		return true
	}
	return false
}
