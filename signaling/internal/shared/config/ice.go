// Package config holds cross-mode configuration for the signaling
// server. AppConfig.Load() (in app.go) is the single env-reading
// entry point; per-type loaders are private helpers there.
//
// Boundary rule: this package MUST NOT import any mode contract.
// `IceServer` here is the INTERNAL representation — no JSON tags.
// Each mode keeps its own wire-payload `IceServer` type with mode-
// specific JSON tags and converts at the boundary (see
// `internal/modes/<id>/handler.go`).
package config

// IceServer is the canonical internal config shape for a single
// RTCIceServer entry. Plain Go fields, no JSON tags. Mode wire types
// embed-or-convert from this.
type IceServer struct {
	URLs       []string
	Username   string
	Credential string
}
