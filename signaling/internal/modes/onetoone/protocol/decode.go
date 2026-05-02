package protocol

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"

	"github.com/google/uuid"
)

// RoomIDRegex is the server-authoritative room-ID validator (§1).
var RoomIDRegex = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

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

// ValidateRoomID returns nil if id matches the RoomIDRegex, else a
// *DecodeError with Code == malformed.
func ValidateRoomID(id string) error {
	if !RoomIDRegex.MatchString(id) {
		return &DecodeError{Code: CodeMalformed, Message: "invalid room ID"}
	}
	return nil
}

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

	if !IsKnownType(env.Type) {
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

func decodePayload(t Type, raw json.RawMessage) (any, error) {
	switch t {
	case TypeJoinRoom:
		return decodeInto[JoinRoomPayload](raw)
	case TypeJoinAccepted:
		return decodeInto[JoinAcceptedPayload](raw)
	case TypeJoinRejected:
		return decodeInto[JoinRejectedPayload](raw)
	case TypePeerPresenceChanged:
		return decodeInto[PeerPresenceChangedPayload](raw)
	case TypeMediaReady:
		return decodeInto[MediaReadyPayload](raw)
	case TypeMediaFailed:
		return decodeInto[MediaFailedPayload](raw)
	case TypeReadyForOffer:
		return decodeInto[ReadyForOfferPayload](raw)
	case TypeOffer:
		return decodeInto[OfferPayload](raw)
	case TypeAnswer:
		return decodeInto[AnswerPayload](raw)
	case TypeIceCandidate:
		return decodeInto[IceCandidatePayload](raw)
	case TypeMediaState:
		return decodeInto[MediaStatePayload](raw)
	case TypePeerLeft:
		return decodeInto[PeerLeftPayload](raw)
	case TypeParticipantReleased:
		return decodeInto[ParticipantReleasedPayload](raw)
	case TypeLeaveRoom:
		return decodeInto[LeaveRoomPayload](raw)
	case TypeError:
		return decodeInto[ErrorPayload](raw)
	}
	return nil, &DecodeError{Code: CodeMalformed, Message: fmt.Sprintf("no decoder for %q", t)}
}

type validator interface {
	Validate() error
}

func decodeInto[T any](raw json.RawMessage) (*T, error) {
	var v T
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &v); err != nil {
			return nil, &DecodeError{Code: CodeMalformed, Message: err.Error()}
		}
	}
	if vv, ok := any(&v).(validator); ok {
		if err := vv.Validate(); err != nil {
			return nil, err
		}
	}
	return &v, nil
}
