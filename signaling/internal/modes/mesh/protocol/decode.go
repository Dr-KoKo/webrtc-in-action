package protocol

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"

	"github.com/google/uuid"
)

// RoomIDRegex — server-authoritative validator (§1.1; identical to v1).
var RoomIDRegex = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

// ValidateRoomID returns nil if id matches RoomIDRegex, else a
// *ProtocolError with Code = malformed.
func ValidateRoomID(id string) error {
	if !RoomIDRegex.MatchString(id) {
		return &ProtocolError{Code: CodeMalformed, Message: "invalid room ID"}
	}
	return nil
}

// IsUUID reports whether s is a syntactically valid UUID. Matches v1's
// permissive policy — the contract specifies UUIDv4 but the validator
// accepts any RFC 4122 form so a Zod `.uuid()` peer is interoperable.
func IsUUID(s string) bool {
	_, err := uuid.Parse(s)
	return err == nil
}

// DecodeEnvelope parses raw bytes into an Envelope + concrete payload
// struct. It performs syntactic validation (JSON shape, v == 2, known
// type) AND payload-shape validation via per-type Validate() methods.
//
// Stateful checks (sender-in-room, sender-is-offerer, pairEpoch
// match) are NOT performed here — the caller composes them with the
// MeshRoom state.
func DecodeEnvelope(raw []byte) (*Decoded, error) {
	var env Envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, ErrMalformed
	}
	if env.V != ContractVersion {
		return nil, ErrUnsupportedVersion
	}
	if !IsKnownType(env.Type) {
		return nil, &ProtocolError{
			Code:    CodeMalformed,
			Message: fmt.Sprintf("unknown message type %q", env.Type),
		}
	}
	if err := validateEnvelope(&env); err != nil {
		return nil, err
	}
	msg, err := decodePayload(env.Type, env.Payload)
	if err != nil {
		var perr *ProtocolError
		if errors.As(err, &perr) {
			return nil, perr
		}
		return nil, &ProtocolError{Code: CodeMalformed, Message: err.Error()}
	}
	return &Decoded{Envelope: env, Message: msg}, nil
}

// EncodeEnvelope marshals an Envelope to JSON. Convenience wrapper
// kept alongside DecodeEnvelope so callers have one symbol pair.
func EncodeEnvelope(env Envelope) ([]byte, error) {
	return json.Marshal(env)
}

// Validate runs the per-type payload validator on the supplied raw
// payload. Useful for fixture / test contexts that already have an
// Envelope but want to re-validate the body.
func Validate(t MessageType, payload json.RawMessage) error {
	if !IsKnownType(t) {
		return &ProtocolError{Code: CodeMalformed, Message: fmt.Sprintf("unknown message type %q", t)}
	}
	_, err := decodePayload(t, payload)
	return err
}

// decodePayload routes by MessageType to the per-type struct + Validate.
func decodePayload(t MessageType, raw json.RawMessage) (any, error) {
	switch t {
	case TypeJoinRoom:
		return decodeInto[JoinRoomPayload](raw)
	case TypeJoinAccepted:
		return decodeInto[JoinAcceptedPayload](raw)
	case TypeJoinRejected:
		return decodeInto[JoinRejectedPayload](raw)
	case TypeMeshRosterSnapshot:
		return decodeInto[MeshRosterSnapshotPayload](raw)
	case TypeMeshRosterUpdate:
		return decodeInto[MeshRosterUpdatePayload](raw)
	case TypeMediaReady:
		return decodeInto[MediaReadyPayload](raw)
	case TypeMediaFailed:
		return decodeInto[MediaFailedPayload](raw)
	case TypeParticipantReleased:
		return decodeInto[ParticipantReleasedPayload](raw)
	case TypePairNegotiationInstruction:
		return decodeInto[PairNegotiationInstructionPayload](raw)
	case TypePairOffer:
		return decodeInto[PairOfferPayload](raw)
	case TypePairAnswer:
		return decodeInto[PairAnswerPayload](raw)
	case TypePairIceCandidate:
		return decodeInto[PairIceCandidatePayload](raw)
	case TypePairMediaState:
		return decodeInto[PairMediaStatePayload](raw)
	case TypeReconnectPair:
		return decodeInto[ReconnectPairPayload](raw)
	case TypePairReconnectInstruction:
		return decodeInto[PairReconnectInstructionPayload](raw)
	case TypePairFailed:
		return decodeInto[PairFailedPayload](raw)
	case TypePeerLeft:
		return decodeInto[PeerLeftPayload](raw)
	case TypeLeaveRoom:
		return decodeInto[LeaveRoomPayload](raw)
	case TypeError:
		return decodeInto[ErrorPayload](raw)
	}
	return nil, &ProtocolError{Code: CodeMalformed, Message: fmt.Sprintf("no decoder for %q", t)}
}

type validator interface{ Validate() error }

func decodeInto[T any](raw json.RawMessage) (*T, error) {
	var v T
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &v); err != nil {
			return nil, &ProtocolError{Code: CodeMalformed, Message: err.Error()}
		}
	}
	if vv, ok := any(&v).(validator); ok {
		if err := vv.Validate(); err != nil {
			return nil, err
		}
	}
	return &v, nil
}
