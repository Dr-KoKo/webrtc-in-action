package protocol

// IceServer mirrors the browser RTCIceServer dictionary. `urls` is
// `string | string[]` per the contract. Relayed inside `join_accepted`
// and `pair_negotiation_instruction` / `pair_reconnect_instruction`.
type IceServer struct {
	URLs       any    `json:"urls"`
	Username   string `json:"username,omitempty"`
	Credential string `json:"credential,omitempty"`
}

// MediaCapabilities — `media_ready.payload.mediaCapabilities`. Both
// fields are required and required-true for v2 (§3.6).
type MediaCapabilities struct {
	Audio bool `json:"audio"`
	Video bool `json:"video"`
}
