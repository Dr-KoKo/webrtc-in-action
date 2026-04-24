// Per-message payload structs + Validate() methods. The Go mirror of
// frontend/src/signaling/schema.ts. Values (enum strings, limits)
// match the canonical contract in
// specs/001-webrtc-1to1-call/contracts/signaling-protocol.md §3.

package signaling

import (
	"encoding/json"
	"fmt"
)

// ---------------------------------------------------------------------
// decodePayload — dispatch table from Type to struct + Validate()
// ---------------------------------------------------------------------

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

// ---------------------------------------------------------------------
// Enum values carried inside payloads
// ---------------------------------------------------------------------

type MediaReadiness string

const (
	MediaPending MediaReadiness = "pending-media"
	MediaReady   MediaReadiness = "ready"
)

type RoomReadiness string

const (
	RoomEmpty            RoomReadiness = "empty"
	RoomWaitingForMedia  RoomReadiness = "waiting_for_media"
	RoomWaitingForPeer   RoomReadiness = "waiting_for_peer"
	RoomPaired           RoomReadiness = "paired"
)

type JoinRejectedResult string

const (
	JoinRejectedRoomFull     JoinRejectedResult = "join_rejected_room_full"
	JoinRejectedInvalidRoom  JoinRejectedResult = "join_rejected_invalid_room"
)

type JoinRejectedReason string

const (
	ReasonRoomFull       JoinRejectedReason = "room_full"
	ReasonInvalidRoomID  JoinRejectedReason = "invalid_room_id"
)

type Presence string

const (
	PresencePendingMedia Presence = "pending-media"
	PresenceReady        Presence = "ready"
	PresenceInCall       Presence = "in-call"
	PresenceLeft         Presence = "left"
	PresenceReleased     Presence = "released"
)

type PresenceReason string

const (
	PresenceReasonAdmitted         PresenceReason = "admitted"
	PresenceReasonMediaReady       PresenceReason = "media_ready"
	PresenceReasonMediaFailed      PresenceReason = "media_failed"
	PresenceReasonRoleAssigned     PresenceReason = "role_assigned"
	PresenceReasonGracefulLeave    PresenceReason = "graceful_leave"
	PresenceReasonDisconnect       PresenceReason = "disconnect"
	PresenceReasonPendingReleased  PresenceReason = "pending_released"
)

type MediaFailedReason string

const (
	MediaFailedPermissionDenied MediaFailedReason = "permission_denied"
	MediaFailedDeviceNotFound   MediaFailedReason = "device_not_found"
	MediaFailedDeviceInUse      MediaFailedReason = "device_in_use"
	MediaFailedOther            MediaFailedReason = "other"
)

type ParticipantReleasedResult string

const (
	ParticipantReleasedMediaFailed  ParticipantReleasedResult = "participant_released_media_failed"
	ParticipantReleasedDisconnect   ParticipantReleasedResult = "participant_released_disconnect"
)

type ParticipantReleasedReason string

const (
	ReleasedReasonMediaFailed ParticipantReleasedReason = "media_failed"
	ReleasedReasonDisconnect  ParticipantReleasedReason = "disconnect"
)

type Role string

const (
	RoleOfferer  Role = "offerer"
	RoleAnswerer Role = "answerer"
)

type PeerLeftReason string

const (
	PeerLeftGracefulLeave PeerLeftReason = "graceful_leave"
	PeerLeftDisconnect    PeerLeftReason = "disconnect"
)

// ---------------------------------------------------------------------
// §3.1 join_room
// ---------------------------------------------------------------------

type JoinRoomPayload struct{}

func (p *JoinRoomPayload) Validate() error { return nil }

// ---------------------------------------------------------------------
// §3.2 join_accepted
// ---------------------------------------------------------------------

type RemotePeerSnapshot struct {
	PeerID         string         `json:"peerId"`
	MediaReadiness MediaReadiness `json:"mediaReadiness"`
}

type JoinAcceptedPayload struct {
	PeerID         string              `json:"peerId"`
	AdmissionOrder int                 `json:"admissionOrder"`
	RoomReadiness  RoomReadiness       `json:"roomReadiness"`
	RemotePeer     *RemotePeerSnapshot `json:"remotePeer"`
}

func (p *JoinAcceptedPayload) Validate() error {
	if !IsUUID(p.PeerID) {
		return &DecodeError{Code: CodeMalformed, Message: "join_accepted.peerId must be a UUID"}
	}
	if p.AdmissionOrder != 1 && p.AdmissionOrder != 2 {
		return &DecodeError{Code: CodeMalformed, Message: "admissionOrder must be 1 or 2"}
	}
	switch p.RoomReadiness {
	case RoomEmpty, RoomWaitingForMedia, RoomWaitingForPeer, RoomPaired:
	default:
		return &DecodeError{Code: CodeMalformed, Message: "unknown roomReadiness"}
	}
	if p.RemotePeer != nil {
		if !IsUUID(p.RemotePeer.PeerID) {
			return &DecodeError{Code: CodeMalformed, Message: "join_accepted.remotePeer.peerId must be a UUID"}
		}
		switch p.RemotePeer.MediaReadiness {
		case MediaPending, MediaReady:
		default:
			return &DecodeError{Code: CodeMalformed, Message: "unknown remotePeer.mediaReadiness"}
		}
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
	default:
		return &DecodeError{Code: CodeMalformed, Message: "join_rejected.result not a JoinResult enum value"}
	}
	switch p.Reason {
	case ReasonRoomFull, ReasonInvalidRoomID:
	default:
		return &DecodeError{Code: CodeMalformed, Message: "join_rejected.reason not a canonical reason"}
	}
	if p.Message == "" {
		return &DecodeError{Code: CodeMalformed, Message: "join_rejected.message required"}
	}
	return nil
}

// ---------------------------------------------------------------------
// §3.4 peer_presence_changed
// ---------------------------------------------------------------------

type PeerPresenceChangedPayload struct {
	SubjectPeerID  string         `json:"subjectPeerId"`
	AdmissionOrder int            `json:"admissionOrder"`
	Presence       Presence       `json:"presence"`
	Reason         PresenceReason `json:"reason"`
}

func (p *PeerPresenceChangedPayload) Validate() error {
	if !IsUUID(p.SubjectPeerID) {
		return &DecodeError{Code: CodeMalformed, Message: "subjectPeerId must be a UUID"}
	}
	if p.AdmissionOrder != 1 && p.AdmissionOrder != 2 {
		return &DecodeError{Code: CodeMalformed, Message: "admissionOrder must be 1 or 2"}
	}
	switch p.Presence {
	case PresencePendingMedia, PresenceReady, PresenceInCall, PresenceLeft, PresenceReleased:
	default:
		return &DecodeError{Code: CodeMalformed, Message: "unknown presence value"}
	}
	switch p.Reason {
	case PresenceReasonAdmitted, PresenceReasonMediaReady, PresenceReasonMediaFailed,
		PresenceReasonRoleAssigned, PresenceReasonGracefulLeave,
		PresenceReasonDisconnect, PresenceReasonPendingReleased:
	default:
		return &DecodeError{Code: CodeMalformed, Message: "unknown presence reason"}
	}
	return nil
}

// ---------------------------------------------------------------------
// §3.5 media_ready
// ---------------------------------------------------------------------

type MediaCapabilities struct {
	Audio bool `json:"audio"`
	Video bool `json:"video"`
}

type MediaReadyPayload struct {
	MediaCapabilities MediaCapabilities `json:"mediaCapabilities"`
}

func (p *MediaReadyPayload) Validate() error {
	if !p.MediaCapabilities.Audio || !p.MediaCapabilities.Video {
		return &DecodeError{
			Code:    CodeUnsupportedMediaCapability,
			Message: "media_ready requires audio=true AND video=true (MVP, §3.5)",
		}
	}
	return nil
}

// ---------------------------------------------------------------------
// §3.6 media_failed
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
	return &DecodeError{Code: CodeMalformed, Message: "media_failed.reason not in enum"}
}

// ---------------------------------------------------------------------
// §3.7 ready_for_offer
// ---------------------------------------------------------------------

// IceServer mirrors the browser RTCIceServer dictionary. urls can be
// either a string or a string list — contract §3.7.
type IceServer struct {
	URLs       any    `json:"urls"`
	Username   string `json:"username,omitempty"`
	Credential string `json:"credential,omitempty"`
}

type ReadyForOfferRemote struct {
	PeerID         string `json:"peerId"`
	AdmissionOrder int    `json:"admissionOrder"`
}

type ReadyForOfferPayload struct {
	Role       Role                `json:"role"`
	RemotePeer ReadyForOfferRemote `json:"remotePeer"`
	IceServers []IceServer         `json:"iceServers"`
}

func (p *ReadyForOfferPayload) Validate() error {
	switch p.Role {
	case RoleOfferer, RoleAnswerer:
	default:
		return &DecodeError{Code: CodeMalformed, Message: "ready_for_offer.role must be offerer/answerer"}
	}
	if p.RemotePeer.PeerID == "" {
		return &DecodeError{Code: CodeMalformed, Message: "remotePeer.peerId required"}
	}
	if p.RemotePeer.AdmissionOrder != 1 && p.RemotePeer.AdmissionOrder != 2 {
		return &DecodeError{Code: CodeMalformed, Message: "remotePeer.admissionOrder must be 1 or 2"}
	}
	return nil
}

// ---------------------------------------------------------------------
// §3.8 offer / §3.9 answer — SDP bodies
// ---------------------------------------------------------------------

// SDPBody is the raw RTCSessionDescriptionInit shape. The server MUST
// NOT parse sdp.sdp — it is opaque bytes (NFR-003).
type SDPBody struct {
	Type string `json:"type"`
	SDP  string `json:"sdp"`
}

type OfferPayload struct {
	SDP SDPBody `json:"sdp"`
}

func (p *OfferPayload) Validate() error {
	if p.SDP.Type != "offer" {
		return &DecodeError{Code: CodeMalformed, Message: "offer.sdp.type must be 'offer'"}
	}
	if p.SDP.SDP == "" {
		return &DecodeError{Code: CodeMalformed, Message: "offer.sdp.sdp required"}
	}
	return nil
}

type AnswerPayload struct {
	SDP SDPBody `json:"sdp"`
}

func (p *AnswerPayload) Validate() error {
	if p.SDP.Type != "answer" {
		return &DecodeError{Code: CodeMalformed, Message: "answer.sdp.type must be 'answer'"}
	}
	if p.SDP.SDP == "" {
		return &DecodeError{Code: CodeMalformed, Message: "answer.sdp.sdp required"}
	}
	return nil
}

// ---------------------------------------------------------------------
// §3.10 ice_candidate
// ---------------------------------------------------------------------

// IceCandidateInit mirrors the browser RTCIceCandidateInit. The
// strings are opaque to the server.
type IceCandidateInit struct {
	Candidate        string  `json:"candidate"`
	SDPMid           *string `json:"sdpMid,omitempty"`
	SDPMLineIndex    *int    `json:"sdpMLineIndex,omitempty"`
	UsernameFragment *string `json:"usernameFragment,omitempty"`
}

// IceCandidatePayload wraps the candidate pointer so we can
// distinguish "end of candidates" (candidate == nil, JSON null) from
// a populated candidate. The empty-string form (candidate: "") is
// explicitly rejected as malformed in Validate below.
type IceCandidatePayload struct {
	Candidate *IceCandidateInit `json:"candidate"`

	// candidatePresent tracks whether the JSON had a `candidate` key at
	// all. If the key was missing, we reject as malformed.
	candidatePresent bool `json:"-"`
}

func (p *IceCandidatePayload) UnmarshalJSON(data []byte) error {
	// Parse into a map first so we can detect the difference between
	// "candidate key missing entirely" (malformed) and "candidate: null"
	// (end-of-candidates, valid).
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	candRaw, ok := raw["candidate"]
	if !ok {
		p.candidatePresent = false
		return nil
	}
	p.candidatePresent = true
	// candidate: null
	if string(candRaw) == "null" {
		p.Candidate = nil
		return nil
	}
	var c IceCandidateInit
	if err := json.Unmarshal(candRaw, &c); err != nil {
		return err
	}
	p.Candidate = &c
	return nil
}

func (p *IceCandidatePayload) Validate() error {
	if !p.candidatePresent {
		return &DecodeError{Code: CodeMalformed, Message: "ice_candidate.candidate key required"}
	}
	if p.Candidate == nil {
		return nil // end-of-candidates
	}
	if p.Candidate.Candidate == "" {
		return &DecodeError{
			Code:    CodeMalformed,
			Message: "ice_candidate.candidate.candidate must not be empty string (use null for end-of-candidates)",
		}
	}
	return nil
}

// ---------------------------------------------------------------------
// §3.11 media_state
// ---------------------------------------------------------------------

type MediaStatePayload struct {
	Microphone  string `json:"microphone"`
	Camera      string `json:"camera"`
	ScreenShare string `json:"screenShare"`
}

func (p *MediaStatePayload) Validate() error {
	switch p.Microphone {
	case "on", "off":
	default:
		return &DecodeError{Code: CodeMalformed, Message: "media_state.microphone must be on/off"}
	}
	switch p.Camera {
	case "on", "off":
	default:
		return &DecodeError{Code: CodeMalformed, Message: "media_state.camera must be on/off"}
	}
	switch p.ScreenShare {
	case "active", "inactive":
	default:
		return &DecodeError{Code: CodeMalformed, Message: "media_state.screenShare must be active/inactive"}
	}
	return nil
}

// ---------------------------------------------------------------------
// §3.12 peer_left
// ---------------------------------------------------------------------

type PeerLeftPayload struct {
	PeerID string         `json:"peerId"`
	Reason PeerLeftReason `json:"reason"`
}

func (p *PeerLeftPayload) Validate() error {
	if !IsUUID(p.PeerID) {
		return &DecodeError{Code: CodeMalformed, Message: "peer_left.peerId must be a UUID"}
	}
	switch p.Reason {
	case PeerLeftGracefulLeave, PeerLeftDisconnect:
		return nil
	}
	return &DecodeError{Code: CodeMalformed, Message: "peer_left.reason must be graceful_leave or disconnect"}
}

// ---------------------------------------------------------------------
// §3.13 participant_released
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
		return &DecodeError{Code: CodeMalformed, Message: "participant_released.result not canonical"}
	}
	switch p.Reason {
	case ReleasedReasonMediaFailed, ReleasedReasonDisconnect:
		return nil
	}
	return &DecodeError{Code: CodeMalformed, Message: "participant_released.reason not canonical"}
}

// ---------------------------------------------------------------------
// §3.14 leave_room
// ---------------------------------------------------------------------

type LeaveRoomPayload struct{}

func (p *LeaveRoomPayload) Validate() error { return nil }

// ---------------------------------------------------------------------
// §3.15 error
// ---------------------------------------------------------------------

type ErrorPayload struct {
	Code       ErrorCode `json:"code"`
	Message    string    `json:"message"`
	Correlates string    `json:"correlates,omitempty"`
}

func (p *ErrorPayload) Validate() error {
	switch p.Code {
	case CodeAlreadyJoined, CodeUnexpectedMediaReady, CodeUnsupportedMediaCapability,
		CodeUnexpectedOffer, CodeUnexpectedAnswer, CodeNotInRoom,
		CodeMalformed, CodeUnsupportedVersion, CodeInternalError:
	default:
		return &DecodeError{Code: CodeMalformed, Message: "error.code not in canonical enum"}
	}
	if p.Message == "" {
		return &DecodeError{Code: CodeMalformed, Message: "error.message required"}
	}
	if p.Correlates != "" && !IsUUID(p.Correlates) {
		return &DecodeError{Code: CodeMalformed, Message: "error.correlates must be a UUID when present"}
	}
	return nil
}
