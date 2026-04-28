// Package config holds cross-mode environment-driven configuration
// loaders. Today: ICE-server list. Future: anything else read from
// the same env keys (e.g. logging level, but logging already lives in
// `internal/shared/logging`).
//
// Boundary rule: this package MUST NOT import any mode contract.
// `IceServer` here is the INTERNAL representation — no JSON tags. Each
// mode keeps its own wire-payload `IceServer` type with mode-specific
// JSON tags and converts at the boundary (see
// `internal/modes/<id>/handler.go`).
package config

import (
	"os"
	"strings"
)

// IceServer is the canonical internal config shape for a single
// RTCIceServer entry. Plain Go fields, no JSON tags. Mode wire types
// embed-or-convert from this.
type IceServer struct {
	URLs       []string
	Username   string
	Credential string
}

// LoadIceServersFromEnv reads VITE_STUN_URLS / VITE_TURN_URL /
// VITE_TURN_USERNAME / VITE_TURN_CREDENTIAL and returns the list. If
// VITE_STUN_URLS is empty or all entries blank-after-trim, falls back
// to a single Google STUN entry. TURN credentials MUST never be
// logged (NFR-003); this loader does not log.
func LoadIceServersFromEnv() []IceServer {
	var servers []IceServer
	if raw := strings.TrimSpace(os.Getenv("VITE_STUN_URLS")); raw != "" {
		var cleaned []string
		for _, u := range strings.Split(raw, ",") {
			if t := strings.TrimSpace(u); t != "" {
				cleaned = append(cleaned, t)
			}
		}
		if len(cleaned) > 0 {
			servers = append(servers, IceServer{URLs: cleaned})
		}
	}
	if len(servers) == 0 {
		servers = append(servers, IceServer{
			URLs: []string{"stun:stun.l.google.com:19302"},
		})
	}
	if turn := strings.TrimSpace(os.Getenv("VITE_TURN_URL")); turn != "" {
		servers = append(servers, IceServer{
			URLs:       []string{turn},
			Username:   os.Getenv("VITE_TURN_USERNAME"),
			Credential: os.Getenv("VITE_TURN_CREDENTIAL"),
		})
	}
	return servers
}
