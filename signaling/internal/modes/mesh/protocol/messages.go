// Admission-family + media-family payload structs and validators
// (contract §3.1–§3.3, §3.6, §3.7, §3.8, §3.17, §3.18, §3.19). Per
// the contract:
//   - `join_rejected.payload.result` is exactly two values:
//     `join_rejected_room_full | join_rejected_invalid_room`.
//     Version mismatch is an `error { code: "unsupported_version" }`,
//     NOT a `join_rejected.result` value.
//   - `participant_released.payload.result` is exactly two values:
//     `participant_released_media_failed | participant_released_disconnect`.

package protocol

// ---------------------------------------------------------------------
// Shared enums carried across multiple admission-family payloads
// ---------------------------------------------------------------------

// JoinRejectedResult is the `join_rejected.payload.result` enum (§3.3).
// Forbidden values (compile-time non-existence): `join_rejected_unsupported_version`.
type JoinRejectedResult string

const (
	JoinRejectedRoomFull    JoinRejectedResult = "join_rejected_room_full"
	JoinRejectedInvalidRoom JoinRejectedResult = "join_rejected_invalid_room"
)

// JoinRejectedReason is the short machine-readable tag (§3.3).
type JoinRejectedReason string

const (
	ReasonRoomFull      JoinRejectedReason = "room_full"
	ReasonInvalidRoomID JoinRejectedReason = "invalid_room_id"
)

// ParticipantReleasedResult is the `participant_released.result` enum
// (§3.8).
type ParticipantReleasedResult string

const (
	ParticipantReleasedMediaFailed ParticipantReleasedResult = "participant_released_media_failed"
	ParticipantReleasedDisconnect  ParticipantReleasedResult = "participant_released_disconnect"
)

// ParticipantReleasedReason — short machine tag (§3.8).
type ParticipantReleasedReason string

const (
	ReleasedReasonMediaFailed ParticipantReleasedReason = "media_failed"
	ReleasedReasonDisconnect  ParticipantReleasedReason = "disconnect"
)

// PeerLeftReason — `peer_left.reason` enum (§3.17).
type PeerLeftReason string

const (
	PeerLeftGracefulLeave PeerLeftReason = "graceful_leave"
	PeerLeftDisconnect    PeerLeftReason = "disconnect"
)

// MediaFailedReason — `media_failed.payload.reason` enum (§3.7).
type MediaFailedReason string

const (
	MediaFailedPermissionDenied MediaFailedReason = "permission_denied"
	MediaFailedDeviceNotFound   MediaFailedReason = "device_not_found"
	MediaFailedDeviceInUse      MediaFailedReason = "device_in_use"
	MediaFailedOther            MediaFailedReason = "other"
)

// ---------------------------------------------------------------------
// §3.1 join_room
// ---------------------------------------------------------------------

type JoinRoomPayload struct{}

func (p *JoinRoomPayload) Validate() error { return nil }

// ---------------------------------------------------------------------
// §3.2 join_accepted
// ---------------------------------------------------------------------

type JoinAcceptedPayload struct {
	PeerID         string      `json:"peerId"`
	AdmissionIndex uint64      `json:"admissionIndex"`
	IceServers     []IceServer `json:"iceServers"`
}

func (p *JoinAcceptedPayload) Validate() error {
	if !IsUUID(p.PeerID) {
		return &ProtocolError{Code: CodeMalformed, Message: "join_accepted.peerId must be a UUID"}
	}
	if p.AdmissionIndex == 0 {
		return &ProtocolError{Code: CodeMalformed, Message: "join_accepted.admissionIndex must be ≥ 1"}
	}
	if len(p.IceServers) == 0 {
		return &ProtocolError{Code: CodeMalformed, Message: "join_accepted.iceServers must be non-empty"}
	}
	return nil
}

// ---------------------------------------------------------------------
// §3.3 join_rejected
// ---------------------------------------------------------------------

type JoinRejectedPayload struct {
	Result  JoinRejectedResult `json:"result"`
	Reason  JoinRejectedReason `json:"reason"`
	Message string             `json:"message"`
}

func (p *JoinRejectedPayload) Validate() error {
	switch p.Result {
	case JoinRejectedRoomFull, JoinRejectedInvalidRoom:
		// ok — version mismatch is `error unsupported_version`, NEVER a join_rejected result.
	default:
		return &ProtocolError{Code: CodeMalformed, Message: "join_rejected.result must be join_rejected_room_full or join_rejected_invalid_room"}
	}
	switch p.Reason {
	case ReasonRoomFull, ReasonInvalidRoomID:
	default:
		return &ProtocolError{Code: CodeMalformed, Message: "join_rejected.reason not in canonical enum"}
	}
	if p.Message == "" {
		return &ProtocolError{Code: CodeMalformed, Message: "join_rejected.message required"}
	}
	return nil
}

// ---------------------------------------------------------------------
// §3.6 media_ready
// ---------------------------------------------------------------------

type MediaReadyPayload struct {
	MediaCapabilities MediaCapabilities `json:"mediaCapabilities"`
}

func (p *MediaReadyPayload) Validate() error {
	if !p.MediaCapabilities.Audio || !p.MediaCapabilities.Video {
		return &ProtocolError{
			Code:    CodeUnsupportedMediaCapability,
			Message: "media_ready requires audio=true AND video=true (MVP)",
		}
	}
	return nil
}

// ---------------------------------------------------------------------
// §3.7 media_failed
// ---------------------------------------------------------------------

type MediaFailedPayload struct {
	Reason MediaFailedReason `json:"reason"`
	Detail string            `json:"detail,omitempty"`
}

func (p *MediaFailedPayload) Validate() error {
	switch p.Reason {
	case MediaFailedPermissionDenied, MediaFailedDeviceNotFound,
		MediaFailedDeviceInUse, MediaFailedOther:
		return nil
	}
	return &ProtocolError{Code: CodeMalformed, Message: "media_failed.reason not in canonical enum"}
}

// ---------------------------------------------------------------------
// §3.8 participant_released
// ---------------------------------------------------------------------

type ParticipantReleasedPayload struct {
	Result ParticipantReleasedResult `json:"result"`
	Reason ParticipantReleasedReason `json:"reason"`
	Detail string                    `json:"detail,omitempty"`
}

func (p *ParticipantReleasedPayload) Validate() error {
	switch p.Result {
	case ParticipantReleasedMediaFailed, ParticipantReleasedDisconnect:
	default:
		return &ProtocolError{Code: CodeMalformed, Message: "participant_released.result not in canonical enum"}
	}
	switch p.Reason {
	case ReleasedReasonMediaFailed, ReleasedReasonDisconnect:
		return nil
	}
	return &ProtocolError{Code: CodeMalformed, Message: "participant_released.reason not in canonical enum"}
}

// ---------------------------------------------------------------------
// §3.17 peer_left
// ---------------------------------------------------------------------

type PeerLeftPayload struct {
	PeerID string         `json:"peerId"`
	Reason PeerLeftReason `json:"reason"`
}

func (p *PeerLeftPayload) Validate() error {
	if !IsUUID(p.PeerID) {
		return &ProtocolError{Code: CodeMalformed, Message: "peer_left.peerId must be a UUID"}
	}
	switch p.Reason {
	case PeerLeftGracefulLeave, PeerLeftDisconnect:
		return nil
	}
	return &ProtocolError{Code: CodeMalformed, Message: "peer_left.reason must be graceful_leave or disconnect"}
}

// ---------------------------------------------------------------------
// §3.18 leave_room
// ---------------------------------------------------------------------

type LeaveRoomPayload struct{}

func (p *LeaveRoomPayload) Validate() error { return nil }

// ---------------------------------------------------------------------
// §3.19 error
// ---------------------------------------------------------------------

type ErrorPayload struct {
	Code       ErrorCode      `json:"code"`
	Message    string         `json:"message"`
	Correlates string         `json:"correlates,omitempty"`
	Context    map[string]any `json:"context,omitempty"`
}

func (p *ErrorPayload) Validate() error {
	for _, c := range AllErrorCodes {
		if c == p.Code {
			if p.Message == "" {
				return &ProtocolError{Code: CodeMalformed, Message: "error.message required"}
			}
			if p.Correlates != "" && !IsUUID(p.Correlates) {
				return &ProtocolError{Code: CodeMalformed, Message: "error.correlates must be a UUID when present"}
			}
			return nil
		}
	}
	return &ProtocolError{Code: CodeMalformed, Message: "error.code not in canonical enum"}
}
