// Package protocol owns the v1 wire schema for the 001 1:1 signaling
// contract: envelope shape, message types, payload structs, and the
// decode pipeline. It has no I/O and no state — see
// specs/signaling-architecture.md §2.2 (Ring 2). The canonical
// contract is specs/001-webrtc-1to1-call/contracts/signaling-protocol.md.
package protocol

import "fmt"

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

// DecodeError is a typed decode failure carrying the contract error
// code the server should surface to the client.
type DecodeError struct {
	Code    ErrorCode
	Message string
}

func (e *DecodeError) Error() string {
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

// sentinel decode errors so callers can branch cheaply.
var (
	ErrUnsupportedVersion = &DecodeError{Code: CodeUnsupportedVersion, Message: "v must be 1"}
	ErrMalformed          = &DecodeError{Code: CodeMalformed, Message: "malformed envelope"}
)
