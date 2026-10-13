package mesh_test

import (
	"errors"
	"time"

	protocol "webrtc-lab/signaling/internal/modes/mesh/protocol"
	"webrtc-lab/signaling/internal/shared/config"
	"webrtc-lab/signaling/internal/shared/heartbeat"
)

// asProtocolError is a tiny errors.As wrapper that returns true if the
// target was populated. Lets callers chain on the bool.
func asProtocolError(err error, target **protocol.ProtocolError) bool {
	return errors.As(err, target)
}

// defaultModeConfig returns the per-mode config tests should use when
// they don't care about heartbeat timing or origin policy. Mirrors the
// production defaults shipped by config.Load() (5 s / 5 s heartbeat,
// permissive WS origin).
func defaultModeConfig() config.ModeConfig {
	return config.ModeConfig{
		Heartbeat: heartbeat.Config{
			PingInterval: 5 * time.Second,
			PongTimeout:  5 * time.Second,
		},
		IceServers: []config.IceServer{{URLs: []string{"stun:stun.l.google.com:19302"}}},
		WebSocket:  config.WebSocketConfig{InsecureSkipVerify: true},
	}
}

// fastModeConfig returns a config with sub-second heartbeat for tests
// that exercise the pong-timeout path without waiting 10 s.
func fastModeConfig() config.ModeConfig {
	cfg := defaultModeConfig()
	cfg.Heartbeat = heartbeat.Config{
		PingInterval: 50 * time.Millisecond,
		PongTimeout:  100 * time.Millisecond,
	}
	return cfg
}
