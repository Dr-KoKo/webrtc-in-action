package protocol

import (
	"encoding/json"
)

// ContractVersion is the wire-protocol version this server speaks.
// Any inbound envelope with a different v MUST be rejected as
// unsupported_version per contract §3.15.
const ContractVersion = 1

// Type is the enum of canonical message types (§3.1–§3.15). The
// legacy names room_full, peer_joined, peer_state_changed, and
// participant_released_media_failed are NOT Type values — the first
// three were removed in review-pass 4, and the fourth is a
// participant_released.payload.result value, not a type.
type Type string

const (
	TypeJoinRoom            Type = "join_room"
	TypeJoinAccepted        Type = "join_accepted"
	TypeJoinRejected        Type = "join_rejected"
	TypePeerPresenceChanged Type = "peer_presence_changed"
	TypeMediaReady          Type = "media_ready"
	TypeMediaFailed         Type = "media_failed"
	TypeReadyForOffer       Type = "ready_for_offer"
	TypeOffer               Type = "offer"
	TypeAnswer              Type = "answer"
	TypeIceCandidate        Type = "ice_candidate"
	TypeMediaState          Type = "media_state"
	TypePeerLeft            Type = "peer_left"
	TypeParticipantReleased Type = "participant_released"
	TypeLeaveRoom           Type = "leave_room"
	TypeError               Type = "error"
)

// AllTypes lists every valid Type. The order mirrors the contract §3
// numbering so a reader can cross-reference at a glance.
var AllTypes = []Type{
	TypeJoinRoom,
	TypeJoinAccepted,
	TypeJoinRejected,
	TypePeerPresenceChanged,
	TypeMediaReady,
	TypeMediaFailed,
	TypeReadyForOffer,
	TypeOffer,
	TypeAnswer,
	TypeIceCandidate,
	TypeMediaState,
	TypePeerLeft,
	TypeParticipantReleased,
	TypeLeaveRoom,
	TypeError,
}

// IsKnownType returns true if t is one of the canonical 15 types.
func IsKnownType(t Type) bool {
	for _, k := range AllTypes {
		if k == t {
			return true
		}
	}
	return false
}

// Envelope is the outer JSON wrapper used by every message on the
// wire. Payload is kept as json.RawMessage so the handler can route
// on Type before decoding the type-specific body.
type Envelope struct {
	V         int             `json:"v"`
	Type      Type            `json:"type"`
	RoomID    string          `json:"roomId,omitempty"`
	From      string          `json:"from,omitempty"`
	To        string          `json:"to,omitempty"`
	RequestID string          `json:"requestId,omitempty"`
	TS        int64           `json:"ts,omitempty"`
	Payload   json.RawMessage `json:"payload,omitempty"`
}

// Decoded is the tagged union returned by Decode. Exactly one of the
// Typed* fields is non-nil; the Envelope is always populated.
type Decoded struct {
	Envelope Envelope
	// Message carries the parsed payload struct for the declared Type.
	// Inspect via a type switch on the concrete *JoinRoomMessage etc.
	Message any
}

// validateEnvelope enforces the envelope-level rules for the types
// the current phase actually wires. It runs AFTER the version +
// known-type checks in Decode and BEFORE per-payload validation.
//
// Scope discipline (Principle IX): only the Phase 3 inbound types
// (join_room, leave_room, error) carry per-type envelope rules
// here. Phase 4+ types extend the switch when each is first wired
// into handler.dispatch — matching the convention used for the
// handler itself. Universal shape rules (UUID fields must BE UUIDs
// when present) apply to every type because they're cheap and
// universally correct.
func validateEnvelope(env *Envelope) *DecodeError {
	// Universal: any UUID-shaped envelope field, if set, must be a
	// syntactically valid UUID.
	if env.From != "" && !IsUUID(env.From) {
		return &DecodeError{Code: CodeMalformed, Message: "envelope.from must be a UUID"}
	}
	if env.To != "" && !IsUUID(env.To) {
		return &DecodeError{Code: CodeMalformed, Message: "envelope.to must be a UUID"}
	}
	if env.RequestID != "" && !IsUUID(env.RequestID) {
		return &DecodeError{Code: CodeMalformed, Message: "envelope.requestId must be a UUID"}
	}

	switch env.Type {
	case TypeJoinRoom:
		if env.RoomID == "" {
			return &DecodeError{Code: CodeMalformed, Message: "join_room requires envelope.roomId"}
		}
		// NOTE: roomId regex-check is deliberately NOT done here.
		// Contract §3.1 routes invalid roomId to a join_rejected
		// message with payload.result = join_rejected_invalid_room
		// (§3.3), not the generic `error` frame. handleJoinRoom owns
		// that path so the admission outcome stays on one canonical
		// channel.
		if env.RequestID == "" {
			return &DecodeError{Code: CodeMalformed, Message: "join_room requires envelope.requestId"}
		}
	case TypeLeaveRoom:
		if env.RoomID == "" {
			return &DecodeError{Code: CodeMalformed, Message: "leave_room requires envelope.roomId"}
		}
		if !RoomIDRegex.MatchString(env.RoomID) {
			return &DecodeError{Code: CodeMalformed, Message: "leave_room.roomId invalid"}
		}
	case TypeError:
		// No extra envelope rules (§3.15: roomId optional, requestId
		// optional). UUID shape is already enforced universally above.
	default:
		// Phase 4+ types. Their envelope-level constraints land when
		// each is wired into handler.dispatch.
	}
	return nil
}
