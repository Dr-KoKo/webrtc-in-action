// Mesh v2 signaling envelope, message-type enum, error codes, and
// decode helpers. Mirror of the 001 `internal/signaling` envelope.go
// kept in its own package so v1 and v2 cannot drift across endpoints.
//
// Canonical contract: specs/002-webrtc-mesh-room/contracts/signaling-protocol.md
//
// Important non-existence guarantees enforced here (audited by
// signaling/tests/mesh/no_signaling_chat_test.go and the contract
// spec):
//   - There is NO `room_full` envelope type. Pre-admission rejection
//     is delivered exclusively via `join_rejected` (§3.3).
//   - There is NO `screen_share_busy` type or error code (§3.19).
//   - There is NO chat-bearing message type — group chat lives on
//     `RTCDataChannel` only (FR-053, M8).
//   - `unsupported_version` is delivered via the `error` channel only
//     (§3.19); it MUST NOT appear as a `join_rejected.result` value.

package mesh

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"

	"github.com/google/uuid"
)

// ContractVersion is the wire-protocol version this endpoint speaks.
// Any inbound envelope with `v != 2` MUST be rejected with
// `error { code: "unsupported_version" }` (§3.19). v=1 stays reserved
// for the 001 endpoint; the two values share no message types
// (§7 cross-mode compatibility).
const ContractVersion = 2

// MessageType is the enum of canonical mesh message types (§3.1–§3.18,
// plus the §3.19 `error` type). Only these names are accepted.
type MessageType string

const (
	TypeJoinRoom                  MessageType = "join_room"
	TypeJoinAccepted              MessageType = "join_accepted"
	TypeJoinRejected              MessageType = "join_rejected"
	TypeMeshRosterSnapshot        MessageType = "mesh_roster_snapshot"
	TypeMeshRosterUpdate          MessageType = "mesh_roster_update"
	TypeMediaReady                MessageType = "media_ready"
	TypeMediaFailed               MessageType = "media_failed"
	TypeParticipantReleased       MessageType = "participant_released"
	TypePairNegotiationInstruction MessageType = "pair_negotiation_instruction"
	TypePairOffer                 MessageType = "pair_offer"
	TypePairAnswer                MessageType = "pair_answer"
	TypePairIceCandidate          MessageType = "pair_ice_candidate"
	TypePairMediaState            MessageType = "pair_media_state"
	TypeReconnectPair             MessageType = "reconnect_pair"
	TypePairReconnectInstruction  MessageType = "pair_reconnect_instruction"
	TypePairFailed                MessageType = "pair_failed"
	TypePeerLeft                  MessageType = "peer_left"
	TypeLeaveRoom                 MessageType = "leave_room"
	TypeError                     MessageType = "error"
)

// AllTypes lists every valid mesh MessageType. Order mirrors the
// contract numbering for cross-reference; iteration order is not
// semantically meaningful at runtime.
var AllTypes = []MessageType{
	TypeJoinRoom,
	TypeJoinAccepted,
	TypeJoinRejected,
	TypeMeshRosterSnapshot,
	TypeMeshRosterUpdate,
	TypeMediaReady,
	TypeMediaFailed,
	TypeParticipantReleased,
	TypePairNegotiationInstruction,
	TypePairOffer,
	TypePairAnswer,
	TypePairIceCandidate,
	TypePairMediaState,
	TypeReconnectPair,
	TypePairReconnectInstruction,
	TypePairFailed,
	TypePeerLeft,
	TypeLeaveRoom,
	TypeError,
}

func isKnownType(t MessageType) bool {
	for _, k := range AllTypes {
		if k == t {
			return true
		}
	}
	return false
}

// ErrorCode is the canonical `error.code` enum (§3.19).
//
// Forbidden codes (compile-time non-existence — keep this list in sync
// with the contract):
//   - `room_full` — pre-admission only, delivered via `join_rejected`.
//   - `invalid_room_id` — same.
//   - `screen_share_busy` — mesh has no room-level current-sharer.
type ErrorCode string

const (
	CodeAlreadyJoined              ErrorCode = "already_joined"
	CodeUnsupportedVersion         ErrorCode = "unsupported_version"
	CodeMalformed                  ErrorCode = "malformed"
	CodeNotInRoom                  ErrorCode = "not_in_room"
	CodeUnexpectedMediaReady       ErrorCode = "unexpected_media_ready"
	CodeUnsupportedMediaCapability ErrorCode = "unsupported_media_capability"
	CodeUnexpectedOffer            ErrorCode = "unexpected_offer"
	CodeUnexpectedAnswer           ErrorCode = "unexpected_answer"
	CodeStalePairEpoch             ErrorCode = "stale_pair_epoch"
	CodeStaleRosterUpdate          ErrorCode = "stale_roster_update"
	CodeInternalError              ErrorCode = "internal_error"
)

// AllErrorCodes is the closed set from contract §3.19. Audited by
// protocol_envelope_test.go to keep code drift out.
var AllErrorCodes = []ErrorCode{
	CodeAlreadyJoined,
	CodeUnsupportedVersion,
	CodeMalformed,
	CodeNotInRoom,
	CodeUnexpectedMediaReady,
	CodeUnsupportedMediaCapability,
	CodeUnexpectedOffer,
	CodeUnexpectedAnswer,
	CodeStalePairEpoch,
	CodeStaleRosterUpdate,
	CodeInternalError,
}

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

// Envelope is the outer JSON wrapper used by every mesh frame.
type Envelope struct {
	V         int             `json:"v"`
	Type      MessageType     `json:"type"`
	RoomID    string          `json:"roomId,omitempty"`
	From      string          `json:"from,omitempty"`
	To        string          `json:"to,omitempty"`
	RequestID string          `json:"requestId,omitempty"`
	TS        int64           `json:"ts,omitempty"`
	Payload   json.RawMessage `json:"payload,omitempty"`
}

// Decoded is the tagged union returned by Decode. Message carries the
// concrete payload struct (e.g., *JoinRoomPayload); Envelope is always
// populated.
type Decoded struct {
	Envelope Envelope
	Message  any
}

// ProtocolError is a typed validation failure carrying the wire
// `error.code` the server should surface back to the client. The
// envelope-level helpers (`Decode`, `ValidatePairEpoch`) construct
// these so the handler simply unwraps and forwards.
type ProtocolError struct {
	Code    ErrorCode
	Message string
}

func (e *ProtocolError) Error() string {
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

// sentinel errors so the handler can branch cheaply.
var (
	ErrUnsupportedVersion = &ProtocolError{Code: CodeUnsupportedVersion, Message: "v must be 2"}
	ErrMalformed          = &ProtocolError{Code: CodeMalformed, Message: "malformed envelope"}
)

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
	if !isKnownType(env.Type) {
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

// EncodeEnvelope marshals an Envelope to JSON. Convenience wrapper kept
// alongside DecodeEnvelope so callers have one symbol pair.
func EncodeEnvelope(env Envelope) ([]byte, error) {
	return json.Marshal(env)
}

// Validate runs the per-type payload validator on the supplied raw
// payload. Useful for fixture / test contexts that already have an
// Envelope but want to re-validate the body.
func Validate(t MessageType, payload json.RawMessage) error {
	if !isKnownType(t) {
		return &ProtocolError{Code: CodeMalformed, Message: fmt.Sprintf("unknown message type %q", t)}
	}
	_, err := decodePayload(t, payload)
	return err
}

// validateEnvelope enforces envelope-level rules that apply to all
// types. Per-type envelope-shape rules (e.g., `to` requirements on
// pair messages) live next to the per-type payload structs.
func validateEnvelope(env *Envelope) *ProtocolError {
	if env.From != "" && !IsUUID(env.From) {
		return &ProtocolError{Code: CodeMalformed, Message: "envelope.from must be a UUID"}
	}
	if env.To != "" && !IsUUID(env.To) {
		return &ProtocolError{Code: CodeMalformed, Message: "envelope.to must be a UUID"}
	}
	if env.RequestID != "" && !IsUUID(env.RequestID) {
		return &ProtocolError{Code: CodeMalformed, Message: "envelope.requestId must be a UUID"}
	}
	switch env.Type {
	case TypeJoinRoom:
		if env.RoomID == "" {
			return &ProtocolError{Code: CodeMalformed, Message: "join_room requires envelope.roomId"}
		}
		if env.RequestID == "" {
			return &ProtocolError{Code: CodeMalformed, Message: "join_room requires envelope.requestId"}
		}
	case TypeLeaveRoom, TypeMediaReady, TypeMediaFailed, TypePairMediaState, TypeReconnectPair:
		if env.RoomID == "" {
			return &ProtocolError{Code: CodeMalformed, Message: string(env.Type) + " requires envelope.roomId"}
		}
	case TypePairOffer, TypePairAnswer, TypePairIceCandidate, TypePairFailed:
		if env.RoomID == "" {
			return &ProtocolError{Code: CodeMalformed, Message: string(env.Type) + " requires envelope.roomId"}
		}
		if env.To == "" {
			return &ProtocolError{Code: CodeMalformed, Message: string(env.Type) + " requires envelope.to"}
		}
	}
	return nil
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

// ---------------------------------------------------------------------
// Pair identity (§1.4)
// ---------------------------------------------------------------------

// MakePairID returns the canonical "<lo>-<hi>" pair identifier for two
// admission indices. The participant with the lower index is always the
// offerer (FR-022). The result is stable regardless of argument order.
func MakePairID(a, b uint64) string {
	if a == b {
		return fmt.Sprintf("%d-%d", a, b)
	}
	pair := []uint64{a, b}
	sort.Slice(pair, func(i, j int) bool { return pair[i] < pair[j] })
	return fmt.Sprintf("%d-%d", pair[0], pair[1])
}

// PairLedger exposes the server's current pair-epoch ledger to validators
// that need to compare an inbound `payload.pairEpoch` against the
// canonical value (data-model §A.5). The MeshRoom (M3) implements this
// interface; tests can supply a fake.
type PairLedger interface {
	CurrentPairEpoch(pairID string) (uint64, bool)
}

// ValidateStalePairEpoch enforces the §A.5 stale-message rule for the
// four pairwise connection-attempt messages (`pair_offer`, `pair_answer`,
// `pair_ice_candidate`, `pair_failed`). Returns
// `ProtocolError{Code: stale_pair_epoch}` when the inbound epoch is
// strictly less than the ledger's current value. Equal epochs pass;
// strictly greater epochs are also rejected because the server is
// epoch-canonical (clients never raise epochs).
//
// `pair_media_state` is exempt — it carries no `pairId`/`pairEpoch`
// (contract §3.13) and is participant-level metadata.
func ValidateStalePairEpoch(pairID string, observed uint64, ledger PairLedger) *ProtocolError {
	current, ok := ledger.CurrentPairEpoch(pairID)
	if !ok {
		return &ProtocolError{
			Code:    CodeStalePairEpoch,
			Message: fmt.Sprintf("pair %q is unknown to the server", pairID),
		}
	}
	if observed < current {
		return &ProtocolError{
			Code:    CodeStalePairEpoch,
			Message: fmt.Sprintf("pair %q expected epoch %d; got %d", pairID, current, observed),
		}
	}
	if observed > current {
		return &ProtocolError{
			Code:    CodeStalePairEpoch,
			Message: fmt.Sprintf("pair %q expected epoch %d; got higher %d (server is epoch-canonical)", pairID, current, observed),
		}
	}
	return nil
}
