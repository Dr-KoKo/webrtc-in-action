// Pair-family payload structs (contract §3.9–§3.16). Invariants
// enforced here:
//   - Pairwise connection-attempt messages (`pair_offer`, `pair_answer`,
//     `pair_ice_candidate`, `pair_failed`) carry `pairId` AND `pairEpoch`
//     in the payload.
//   - `pair_negotiation_instruction` and `pair_reconnect_instruction`
//     carry `pairId`, `pairEpoch`, `role`, `remotePeer`, `iceServers`.
//   - `pair_media_state` carries the FULL triple (mic / camera /
//     screen) and explicitly DOES NOT carry `pairId` or `pairEpoch`
//     (§3.13 note: it is participant-level metadata).
//   - `pair_ice_candidate` accepts `candidate: null` (end-of-candidates)
//     and rejects `candidate: ""` as `malformed`.
//   - `reconnect_pair` carries `pairId` + `observedEpoch`.

package mesh

import "encoding/json"

// PairRole — §3.9 / §3.15. The participant with the lower
// `admissionIndex` of the pair is `offerer`.
type PairRole string

const (
	RoleOfferer  PairRole = "offerer"
	RoleAnswerer PairRole = "answerer"
)

// RemotePeerRef — minimal remote-peer descriptor used by the pair
// instruction payloads.
type RemotePeerRef struct {
	PeerID         string `json:"peerId"`
	AdmissionIndex uint64 `json:"admissionIndex"`
}

// SDPBody — opaque RTCSessionDescriptionInit shape. The server NEVER
// parses `sdp.sdp` — NFR-003. Validation only checks the discriminant
// `type` field.
type SDPBody struct {
	Type string `json:"type"`
	SDP  string `json:"sdp"`
}

// IceCandidateInit — opaque RTCIceCandidateInit. Strings are not
// inspected by the server.
type IceCandidateInit struct {
	Candidate        string  `json:"candidate"`
	SDPMid           *string `json:"sdpMid,omitempty"`
	SDPMLineIndex    *int    `json:"sdpMLineIndex,omitempty"`
	UsernameFragment *string `json:"usernameFragment,omitempty"`
}

// pairIdentity is embedded in every pairwise payload. Validating
// requires both `pairId` and `pairEpoch` to be present.
type pairIdentity struct {
	PairID    string `json:"pairId"`
	PairEpoch uint64 `json:"pairEpoch"`
}

func (p pairIdentity) validate(label string) *ProtocolError {
	if p.PairID == "" {
		return &ProtocolError{Code: CodeMalformed, Message: label + ".pairId required"}
	}
	if p.PairEpoch == 0 {
		return &ProtocolError{Code: CodeMalformed, Message: label + ".pairEpoch must be ≥ 1"}
	}
	return nil
}

// ---------------------------------------------------------------------
// §3.9 pair_negotiation_instruction
// §3.15 pair_reconnect_instruction (same payload shape; different type)
// ---------------------------------------------------------------------

type PairNegotiationInstructionPayload struct {
	pairIdentity
	Role       PairRole      `json:"role"`
	RemotePeer RemotePeerRef `json:"remotePeer"`
	IceServers []IceServer   `json:"iceServers"`
}

func (p *PairNegotiationInstructionPayload) UnmarshalJSON(data []byte) error {
	type aux struct {
		PairID     string        `json:"pairId"`
		PairEpoch  uint64        `json:"pairEpoch"`
		Role       PairRole      `json:"role"`
		RemotePeer RemotePeerRef `json:"remotePeer"`
		IceServers []IceServer   `json:"iceServers"`
	}
	var a aux
	if err := json.Unmarshal(data, &a); err != nil {
		return err
	}
	p.PairID = a.PairID
	p.PairEpoch = a.PairEpoch
	p.Role = a.Role
	p.RemotePeer = a.RemotePeer
	p.IceServers = a.IceServers
	return nil
}

func (p *PairNegotiationInstructionPayload) Validate() error {
	if err := p.pairIdentity.validate("pair_negotiation_instruction"); err != nil {
		return err
	}
	switch p.Role {
	case RoleOfferer, RoleAnswerer:
	default:
		return &ProtocolError{Code: CodeMalformed, Message: "pair_negotiation_instruction.role must be offerer|answerer"}
	}
	if !IsUUID(p.RemotePeer.PeerID) {
		return &ProtocolError{Code: CodeMalformed, Message: "pair_negotiation_instruction.remotePeer.peerId must be a UUID"}
	}
	if p.RemotePeer.AdmissionIndex == 0 {
		return &ProtocolError{Code: CodeMalformed, Message: "pair_negotiation_instruction.remotePeer.admissionIndex must be ≥ 1"}
	}
	if len(p.IceServers) == 0 {
		return &ProtocolError{Code: CodeMalformed, Message: "pair_negotiation_instruction.iceServers must be non-empty"}
	}
	return nil
}

type PairReconnectInstructionPayload PairNegotiationInstructionPayload

func (p *PairReconnectInstructionPayload) UnmarshalJSON(data []byte) error {
	return (*PairNegotiationInstructionPayload)(p).UnmarshalJSON(data)
}

func (p *PairReconnectInstructionPayload) Validate() error {
	return (*PairNegotiationInstructionPayload)(p).Validate()
}

// ---------------------------------------------------------------------
// §3.10 pair_offer
// ---------------------------------------------------------------------

type PairOfferPayload struct {
	pairIdentity
	SDP SDPBody `json:"sdp"`
}

func (p *PairOfferPayload) UnmarshalJSON(data []byte) error {
	type aux struct {
		PairID    string  `json:"pairId"`
		PairEpoch uint64  `json:"pairEpoch"`
		SDP       SDPBody `json:"sdp"`
	}
	var a aux
	if err := json.Unmarshal(data, &a); err != nil {
		return err
	}
	p.PairID = a.PairID
	p.PairEpoch = a.PairEpoch
	p.SDP = a.SDP
	return nil
}

func (p *PairOfferPayload) Validate() error {
	if err := p.pairIdentity.validate("pair_offer"); err != nil {
		return err
	}
	if p.SDP.Type != "offer" {
		return &ProtocolError{Code: CodeMalformed, Message: "pair_offer.sdp.type must be 'offer'"}
	}
	if p.SDP.SDP == "" {
		return &ProtocolError{Code: CodeMalformed, Message: "pair_offer.sdp.sdp required"}
	}
	return nil
}

// ---------------------------------------------------------------------
// §3.11 pair_answer
// ---------------------------------------------------------------------

type PairAnswerPayload struct {
	pairIdentity
	SDP SDPBody `json:"sdp"`
}

func (p *PairAnswerPayload) UnmarshalJSON(data []byte) error {
	type aux struct {
		PairID    string  `json:"pairId"`
		PairEpoch uint64  `json:"pairEpoch"`
		SDP       SDPBody `json:"sdp"`
	}
	var a aux
	if err := json.Unmarshal(data, &a); err != nil {
		return err
	}
	p.PairID = a.PairID
	p.PairEpoch = a.PairEpoch
	p.SDP = a.SDP
	return nil
}

func (p *PairAnswerPayload) Validate() error {
	if err := p.pairIdentity.validate("pair_answer"); err != nil {
		return err
	}
	if p.SDP.Type != "answer" {
		return &ProtocolError{Code: CodeMalformed, Message: "pair_answer.sdp.type must be 'answer'"}
	}
	if p.SDP.SDP == "" {
		return &ProtocolError{Code: CodeMalformed, Message: "pair_answer.sdp.sdp required"}
	}
	return nil
}

// ---------------------------------------------------------------------
// §3.12 pair_ice_candidate
// ---------------------------------------------------------------------

// PairIceCandidatePayload distinguishes "candidate key missing"
// (malformed), "candidate: null" (end-of-candidates, valid), and
// "candidate: <init>" (normal). The empty-string form `candidate: ""`
// is rejected as malformed (§3.12).
type PairIceCandidatePayload struct {
	pairIdentity
	Candidate        *IceCandidateInit `json:"candidate"`
	candidatePresent bool              `json:"-"`
}

func (p *PairIceCandidatePayload) UnmarshalJSON(data []byte) error {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	if v, ok := raw["pairId"]; ok {
		if err := json.Unmarshal(v, &p.PairID); err != nil {
			return err
		}
	}
	if v, ok := raw["pairEpoch"]; ok {
		if err := json.Unmarshal(v, &p.PairEpoch); err != nil {
			return err
		}
	}
	candRaw, ok := raw["candidate"]
	if !ok {
		p.candidatePresent = false
		return nil
	}
	p.candidatePresent = true
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

func (p *PairIceCandidatePayload) Validate() error {
	if err := p.pairIdentity.validate("pair_ice_candidate"); err != nil {
		return err
	}
	if !p.candidatePresent {
		return &ProtocolError{Code: CodeMalformed, Message: "pair_ice_candidate.candidate key required"}
	}
	if p.Candidate == nil {
		return nil // end-of-candidates
	}
	if p.Candidate.Candidate == "" {
		return &ProtocolError{
			Code:    CodeMalformed,
			Message: "pair_ice_candidate.candidate.candidate must not be empty string (use null for end-of-candidates)",
		}
	}
	return nil
}

// ---------------------------------------------------------------------
// §3.13 pair_media_state — participant-level (NO pairId / pairEpoch)
// ---------------------------------------------------------------------

// MicState / CameraState / ScreenShareState — the three required fields
// on every `pair_media_state`. Partial updates are not supported.
type MicState string
type CameraState string
type ScreenShareState string

const (
	MicOn   MicState = "on"
	MicOff  MicState = "off"
	CamOn   CameraState = "on"
	CamOff  CameraState = "off"
	ScreenActive   ScreenShareState = "active"
	ScreenInactive ScreenShareState = "inactive"
)

type PairMediaStatePayload struct {
	Microphone  MicState         `json:"microphone"`
	Camera      CameraState      `json:"camera"`
	ScreenShare ScreenShareState `json:"screenShare"`
}

func (p *PairMediaStatePayload) Validate() error {
	switch p.Microphone {
	case MicOn, MicOff:
	default:
		return &ProtocolError{Code: CodeMalformed, Message: "pair_media_state.microphone must be on|off"}
	}
	switch p.Camera {
	case CamOn, CamOff:
	default:
		return &ProtocolError{Code: CodeMalformed, Message: "pair_media_state.camera must be on|off"}
	}
	switch p.ScreenShare {
	case ScreenActive, ScreenInactive:
	default:
		return &ProtocolError{Code: CodeMalformed, Message: "pair_media_state.screenShare must be active|inactive"}
	}
	return nil
}

// ---------------------------------------------------------------------
// §3.14 reconnect_pair
// ---------------------------------------------------------------------

type ReconnectPairPayload struct {
	PairID        string `json:"pairId"`
	ObservedEpoch uint64 `json:"observedEpoch"`
}

func (p *ReconnectPairPayload) Validate() error {
	if p.PairID == "" {
		return &ProtocolError{Code: CodeMalformed, Message: "reconnect_pair.pairId required"}
	}
	if p.ObservedEpoch == 0 {
		return &ProtocolError{Code: CodeMalformed, Message: "reconnect_pair.observedEpoch must be ≥ 1"}
	}
	return nil
}

// ---------------------------------------------------------------------
// §3.16 pair_failed (C→S→C)
// ---------------------------------------------------------------------

// PairFailedReason — `pair_failed.reason` enum (§3.16).
type PairFailedReason string

const (
	PairFailedICE        PairFailedReason = "ice_failure"
	PairFailedDTLS       PairFailedReason = "dtls_failure"
	PairFailedTransport  PairFailedReason = "transport_drop"
	PairFailedConnection PairFailedReason = "connection_state_failed"
	PairFailedApp        PairFailedReason = "application"
)

type PairFailedPayload struct {
	pairIdentity
	Reason PairFailedReason `json:"reason"`
	Detail string           `json:"detail,omitempty"`
}

func (p *PairFailedPayload) UnmarshalJSON(data []byte) error {
	type aux struct {
		PairID    string           `json:"pairId"`
		PairEpoch uint64           `json:"pairEpoch"`
		Reason    PairFailedReason `json:"reason"`
		Detail    string           `json:"detail,omitempty"`
	}
	var a aux
	if err := json.Unmarshal(data, &a); err != nil {
		return err
	}
	p.PairID = a.PairID
	p.PairEpoch = a.PairEpoch
	p.Reason = a.Reason
	p.Detail = a.Detail
	return nil
}

func (p *PairFailedPayload) Validate() error {
	if err := p.pairIdentity.validate("pair_failed"); err != nil {
		return err
	}
	switch p.Reason {
	case PairFailedICE, PairFailedDTLS, PairFailedTransport,
		PairFailedConnection, PairFailedApp:
		return nil
	}
	return &ProtocolError{Code: CodeMalformed, Message: "pair_failed.reason not in canonical enum"}
}
