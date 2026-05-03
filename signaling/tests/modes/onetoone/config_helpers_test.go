package tests

import (
	"time"

	"webrtc-lab/signaling/internal/shared/config"
	"webrtc-lab/signaling/internal/shared/heartbeat"
)

// defaultModeConfig returns the per-mode config tests should use when
// they don't care about heartbeat timing or origin policy. Mirrors the
// production defaults shipped by config.Load() (5 s / 5 s heartbeat,
// permissive WS origin) so tests that need different timing can
// override only the field they care about.
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

// slowModeConfig returns a config that keeps the heartbeat from
// firing during short tests (10 s intervals). Used by protocol-flow
// tests that don't want to race a default 50 ms ping.
func slowModeConfig() config.ModeConfig {
	cfg := defaultModeConfig()
	cfg.Heartbeat = heartbeat.Config{
		PingInterval: 10 * time.Second,
		PongTimeout:  10 * time.Second,
	}
	return cfg
}
