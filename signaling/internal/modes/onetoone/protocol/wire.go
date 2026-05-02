package protocol

// Wire-level enums and small reusable structures shared across
// payloads. Per-payload-only enums (e.g. JoinRejectedReason) live
// next to their payload struct in messages.go.

type MediaReadiness string

const (
	MediaPending MediaReadiness = "pending-media"
	MediaReady   MediaReadiness = "ready"
)

type RoomReadiness string

const (
	RoomEmpty           RoomReadiness = "empty"
	RoomWaitingForMedia RoomReadiness = "waiting_for_media"
	RoomWaitingForPeer  RoomReadiness = "waiting_for_peer"
	RoomPaired          RoomReadiness = "paired"
)

type Presence string

const (
	PresencePendingMedia Presence = "pending-media"
	PresenceReady        Presence = "ready"
	PresenceInCall       Presence = "in-call"
	PresenceLeft         Presence = "left"
	PresenceReleased     Presence = "released"
)

type Role string

const (
	RoleOfferer  Role = "offerer"
	RoleAnswerer Role = "answerer"
)

// IceServer mirrors the browser RTCIceServer dictionary. urls can be
// either a string or a string list — contract §3.7.
type IceServer struct {
	URLs       any    `json:"urls"`
	Username   string `json:"username,omitempty"`
	Credential string `json:"credential,omitempty"`
}

// MediaCapabilities is the audio/video capability bundle inside
// media_ready (§3.5).
type MediaCapabilities struct {
	Audio bool `json:"audio"`
	Video bool `json:"video"`
}

// SDPBody is the raw RTCSessionDescriptionInit shape. The server MUST
// NOT parse sdp.sdp — it is opaque bytes (NFR-003).
type SDPBody struct {
	Type string `json:"type"`
	SDP  string `json:"sdp"`
}

// IceCandidateInit mirrors the browser RTCIceCandidateInit. The
// strings are opaque to the server.
type IceCandidateInit struct {
	Candidate        string  `json:"candidate"`
	SDPMid           *string `json:"sdpMid,omitempty"`
	SDPMLineIndex    *int    `json:"sdpMLineIndex,omitempty"`
	UsernameFragment *string `json:"usernameFragment,omitempty"`
}

// RemotePeerSnapshot is the embedded peer description inside
// join_accepted (§3.2).
type RemotePeerSnapshot struct {
	PeerID         string         `json:"peerId"`
	MediaReadiness MediaReadiness `json:"mediaReadiness"`
}

// ReadyForOfferRemote is the embedded peer description inside
// ready_for_offer (§3.7).
type ReadyForOfferRemote struct {
	PeerID         string `json:"peerId"`
	AdmissionOrder int    `json:"admissionOrder"`
}
