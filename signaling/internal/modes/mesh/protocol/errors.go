// Package protocol owns the v2 wire schema for the 002 mesh
// signaling contract: envelope shape, message types, payload
// structs, and the decode pipeline. It has no I/O and no state — see
// specs/signaling-architecture.md §2.2 (Ring 2). The canonical
// contract is specs/002-webrtc-mesh-room/contracts/signaling-protocol.md.
//
// Important non-existence guarantees enforced here (audited by
// signaling/tests/modes/mesh/no_signaling_chat_test.go and the
// contract spec):
//   - There is NO `room_full` envelope type. Pre-admission rejection
//     is delivered exclusively via `join_rejected` (§3.3).
//   - There is NO `screen_share_busy` type or error code (§3.19).
//   - There is NO chat-bearing message type — group chat lives on
//     `RTCDataChannel` only (FR-053, M8).
//   - `unsupported_version` is delivered via the `error` channel only
//     (§3.19); it MUST NOT appear as a `join_rejected.result` value.
package protocol

import "fmt"

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

// ProtocolError is a typed validation failure carrying the wire
// `error.code` the server should surface back to the client. The
// envelope-level helpers (`DecodeEnvelope`, `ValidateStalePairEpoch`)
// construct these so the handler simply unwraps and forwards.
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
