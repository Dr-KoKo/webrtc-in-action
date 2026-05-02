// Package signaling implements the server side of the
// webrtc-lab v1 signaling contract. This file defines the envelope
// and generic decode helper; per-message payload structs and their
// validators live in messages.go.
//
// Canonical contract: specs/001-webrtc-1to1-call/contracts/signaling-protocol.md
package onetoone

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"

	"github.com/google/uuid"
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
	TypeJoinRoom             Type = "join_room"
	TypeJoinAccepted         Type = "join_accepted"
	TypeJoinRejected         Type = "join_rejected"
	TypePeerPresenceChanged  Type = "peer_presence_changed"
	TypeMediaReady           Type = "media_ready"
	TypeMediaFailed          Type = "media_failed"
	TypeReadyForOffer        Type = "ready_for_offer"
	TypeOffer                Type = "offer"
	TypeAnswer               Type = "answer"
	TypeIceCandidate         Type = "ice_candidate"
	TypeMediaState           Type = "media_state"
	TypePeerLeft             Type = "peer_left"
	TypeParticipantReleased  Type = "participant_released"
	TypeLeaveRoom            Type = "leave_room"
	TypeError                Type = "error"
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

// ErrorCode is the canonical code enum for `error` messages (§3.15).
type ErrorCode string

const (
	CodeAlreadyJoined              ErrorCode = "already_joined"
	CodeUnexpectedMediaReady       ErrorCode = "unexpected_media_ready"
	CodeUnsupportedMediaCapability ErrorCode = "unsupported_media_capability"
	CodeUnexpectedOffer            ErrorCode = "unexpected_offer"
	CodeUnexpectedAnswer           ErrorCode = "unexpected_answer"
	CodeNotInRoom                  ErrorCode = "not_in_room"
	CodeMalformed                  ErrorCode = "malformed"
	CodeUnsupportedVersion         ErrorCode = "unsupported_version"
	CodeInternalError              ErrorCode = "internal_error"
)

// RoomIDRegex is the server-authoritative room-ID validator (§1).
var RoomIDRegex = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

// isKnownType returns true if t is one of the canonical 15 types.
func isKnownType(t Type) bool {
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

// DecodeError is a typed decode failure carrying the contract error
// code the server should surface to the client.
type DecodeError struct {
	Code    ErrorCode
	Message string
}

func (e *DecodeError) Error() string {
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

// sentinel decode errors so the handler can branch cheaply.
var (
	ErrUnsupportedVersion = &DecodeError{Code: CodeUnsupportedVersion, Message: "v must be 1"}
	ErrMalformed          = &DecodeError{Code: CodeMalformed, Message: "malformed envelope"}
)

// Decode parses raw bytes into an Envelope + concrete payload struct.
// It performs BOTH syntactic validation (JSON shape, v==1, known type)
// AND payload-shape validation via the per-type Validate() methods.
//
// Stateful checks (is-sender-in-room, is-sender-the-offerer, etc.) are
// the caller's responsibility — Decode does NOT look at any state
// outside the single message.
func Decode(raw []byte) (*Decoded, error) {
	var env Envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, ErrMalformed
	}

	if env.V != ContractVersion {
		return nil, ErrUnsupportedVersion
	}

	if !isKnownType(env.Type) {
		return nil, &DecodeError{
			Code:    CodeMalformed,
			Message: fmt.Sprintf("unknown message type %q", env.Type),
		}
	}

	if err := validateEnvelope(&env); err != nil {
		return nil, err
	}

	msg, err := decodePayload(env.Type, env.Payload)
	if err != nil {
		var derr *DecodeError
		if errors.As(err, &derr) {
			return nil, derr
		}
		return nil, &DecodeError{Code: CodeMalformed, Message: err.Error()}
	}

	return &Decoded{Envelope: env, Message: msg}, nil
}

// ValidateRoomID returns nil if id matches the RoomIDRegex, else a
// *DecodeError with Code == malformed.
func ValidateRoomID(id string) error {
	if !RoomIDRegex.MatchString(id) {
		return &DecodeError{Code: CodeMalformed, Message: "invalid room ID"}
	}
	return nil
}

// IsUUID reports whether s is a syntactically valid UUID of any
// version. The contract describes server-generated IDs as UUIDv4
// (§1 line 43, §54) but validators on both sides (Go uuid.Parse and
// Zod .uuid()) accept any valid UUID syntactically. Keeping the
// validator loose matches the frontend and avoids false rejections
// of legitimately-formed values.
func IsUUID(s string) bool {
	_, err := uuid.Parse(s)
	return err == nil
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
