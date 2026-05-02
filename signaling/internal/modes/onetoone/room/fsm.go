// fsm.go — stateful relay validators (T034A).
//
// These helpers implement the (role × mediaReadiness × callPhase)
// truth table from contract §§3.8–3.11 and data-model §C.2. They are
// intentionally layered BELOW the signaling package so the verbs can
// call them without importing per-message envelope types — the
// helpers return a typed *RelayError carrying the wire `error.code`
// as a plain string, and the signaling layer maps that string onto
// its protocol.ErrorCode enum.
//
// The helpers NEVER parse the message payload (SDP / ICE strings are
// opaque bytes at this layer — NFR-003); they validate purely against
// Room + Participant state plus the caller-supplied assigned role.

package room

import "fmt"

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
// The signaling layer re-types these onto its protocol.ErrorCode
// enum; kept as plain strings here so the room package has no upward
// dependency.
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

// CanSendOffer enforces the three-field truth table for §3.8 `offer`
// at the sender state. Must be called under the room lock.
//
//	role           == offerer
//	mediaReadiness == ready
//	callPhase      == role-assigned  → accept (advance to negotiating)
//	callPhase      == negotiating    → reject (duplicate offer, EC-013)
//	anything else                    → reject (unexpected_offer)
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
//	role           == answerer
//	mediaReadiness == ready
//	callPhase      ∈ {role-assigned, negotiating}
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
