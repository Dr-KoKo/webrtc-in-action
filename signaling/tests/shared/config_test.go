package tests

// config_test.go — coverage for internal/shared/config.Load(), the
// single env-reading entry point for the signaling server. Replaces
// the pre-refactor TestLoadFromEnvDefaults / TestLoadFromEnvOverrides
// in heartbeat_test.go; env reading no longer lives in the heartbeat
// package.

import (
	"log/slog"
	"strings"
	"testing"
	"time"

	"webrtc-lab/signaling/internal/shared/config"
	"webrtc-lab/signaling/internal/shared/logging"
)

// clearAppEnv unsets every env var Load() reads so a test starts from
// a known-clean state regardless of what compose / shell put in place.
func clearAppEnv(t *testing.T) {
	t.Helper()
	for _, k := range []string{
		"APP_ENV",
		"SIGNALING_PORT",
		"LOG_LEVEL",
		"LOG_FORMAT",
		"PING_INTERVAL_MS",
		"PONG_TIMEOUT_MS",
		"WS_ALLOWED_ORIGINS",
		"ICE_STUN_URLS",
		"ICE_TURN_URL",
		"ICE_TURN_USERNAME",
		"ICE_TURN_CREDENTIAL",
	} {
		t.Setenv(k, "")
	}
}

func TestConfigLoad_Defaults(t *testing.T) {
	clearAppEnv(t)

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Load(): unexpected error: %v", err)
	}
	if cfg.Env != config.EnvDev {
		t.Errorf("Env = %q, want dev", cfg.Env)
	}
	if cfg.Server.Port != "8080" {
		t.Errorf("Server.Port = %q, want 8080", cfg.Server.Port)
	}
	if cfg.Logging.Level != slog.LevelInfo {
		t.Errorf("Logging.Level = %v, want INFO", cfg.Logging.Level)
	}
	if cfg.Logging.Format != logging.FormatJSON {
		t.Errorf("Logging.Format = %q, want json", cfg.Logging.Format)
	}
	if cfg.Shared.Heartbeat.PingInterval != 5*time.Second {
		t.Errorf("Heartbeat.PingInterval = %v, want 5s", cfg.Shared.Heartbeat.PingInterval)
	}
	if cfg.Shared.Heartbeat.PongTimeout != 5*time.Second {
		t.Errorf("Heartbeat.PongTimeout = %v, want 5s", cfg.Shared.Heartbeat.PongTimeout)
	}
	if !cfg.Shared.WebSocket.InsecureSkipVerify {
		t.Errorf("WebSocket.InsecureSkipVerify = false, want true (dev default)")
	}
	if len(cfg.Shared.WebSocket.OriginPatterns) != 0 {
		t.Errorf("WebSocket.OriginPatterns = %v, want empty (dev default)", cfg.Shared.WebSocket.OriginPatterns)
	}
	// Default ICE: single Google STUN entry, no TURN.
	if len(cfg.Shared.IceServers) != 1 {
		t.Fatalf("IceServers count = %d, want 1 (default STUN only)", len(cfg.Shared.IceServers))
	}
	if got := cfg.Shared.IceServers[0].URLs; len(got) != 1 || got[0] != "stun:stun.l.google.com:19302" {
		t.Errorf("IceServers[0].URLs = %v, want [stun:stun.l.google.com:19302]", got)
	}
	// Modes get the same shared values today.
	if cfg.Modes.OneToOne.Heartbeat != cfg.Shared.Heartbeat {
		t.Error("Modes.OneToOne.Heartbeat != Shared.Heartbeat")
	}
	if cfg.Modes.Mesh.Heartbeat != cfg.Shared.Heartbeat {
		t.Error("Modes.Mesh.Heartbeat != Shared.Heartbeat")
	}
}

func TestConfigLoad_HeartbeatOverrides(t *testing.T) {
	clearAppEnv(t)
	t.Setenv("PING_INTERVAL_MS", "1234")
	t.Setenv("PONG_TIMEOUT_MS", "5678")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Load(): %v", err)
	}
	if cfg.Shared.Heartbeat.PingInterval != 1234*time.Millisecond {
		t.Errorf("PingInterval = %v, want 1234ms", cfg.Shared.Heartbeat.PingInterval)
	}
	if cfg.Shared.Heartbeat.PongTimeout != 5678*time.Millisecond {
		t.Errorf("PongTimeout = %v, want 5678ms", cfg.Shared.Heartbeat.PongTimeout)
	}
}

func TestConfigLoad_HeartbeatRejectsInvalid(t *testing.T) {
	clearAppEnv(t)
	t.Setenv("PING_INTERVAL_MS", "abc")

	_, err := config.Load()
	if err == nil {
		t.Fatal("Load(): expected error for invalid PING_INTERVAL_MS, got nil")
	}
	if !strings.Contains(err.Error(), "PING_INTERVAL_MS") {
		t.Errorf("error = %q, want it to mention PING_INTERVAL_MS", err)
	}
}

func TestConfigLoad_RejectsBadAppEnv(t *testing.T) {
	clearAppEnv(t)
	t.Setenv("APP_ENV", "staging")

	_, err := config.Load()
	if err == nil {
		t.Fatal("Load(): expected error for APP_ENV=staging, got nil")
	}
}

func TestConfigLoad_ProdRequiresAllowedOrigins(t *testing.T) {
	clearAppEnv(t)
	t.Setenv("APP_ENV", "prod")

	_, err := config.Load()
	if err == nil {
		t.Fatal("Load(): expected error when prod has no WS_ALLOWED_ORIGINS, got nil")
	}
	if !strings.Contains(err.Error(), "WS_ALLOWED_ORIGINS") {
		t.Errorf("error = %q, want it to mention WS_ALLOWED_ORIGINS", err)
	}
}

func TestConfigLoad_ProdAcceptsAllowedOrigins(t *testing.T) {
	clearAppEnv(t)
	t.Setenv("APP_ENV", "prod")
	t.Setenv("WS_ALLOWED_ORIGINS", "https://example.com, https://app.example.com")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Load(): %v", err)
	}
	if cfg.Shared.WebSocket.InsecureSkipVerify {
		t.Error("InsecureSkipVerify = true in prod with explicit origins; want false")
	}
	want := []string{"https://example.com", "https://app.example.com"}
	if got := cfg.Shared.WebSocket.OriginPatterns; len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Errorf("OriginPatterns = %v, want %v", got, want)
	}
}

func TestConfigLoad_DevWithExplicitOrigins(t *testing.T) {
	clearAppEnv(t)
	t.Setenv("WS_ALLOWED_ORIGINS", "https://localhost:5173")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Load(): %v", err)
	}
	if cfg.Shared.WebSocket.InsecureSkipVerify {
		t.Error("InsecureSkipVerify = true in dev with explicit origins; want false")
	}
	if got := cfg.Shared.WebSocket.OriginPatterns; len(got) != 1 || got[0] != "https://localhost:5173" {
		t.Errorf("OriginPatterns = %v, want [https://localhost:5173]", got)
	}
}

func TestConfigLoad_IceWithTurn(t *testing.T) {
	clearAppEnv(t)
	t.Setenv("ICE_STUN_URLS", "stun:custom:3478,stun:other:3478")
	t.Setenv("ICE_TURN_URL", "turn:relay:3478")
	t.Setenv("ICE_TURN_USERNAME", "user")
	t.Setenv("ICE_TURN_CREDENTIAL", "secret")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Load(): %v", err)
	}
	if len(cfg.Shared.IceServers) != 2 {
		t.Fatalf("IceServers count = %d, want 2 (STUN entry + TURN entry)", len(cfg.Shared.IceServers))
	}
	stun := cfg.Shared.IceServers[0]
	if len(stun.URLs) != 2 || stun.URLs[0] != "stun:custom:3478" || stun.URLs[1] != "stun:other:3478" {
		t.Errorf("STUN URLs = %v, want [stun:custom:3478 stun:other:3478]", stun.URLs)
	}
	turn := cfg.Shared.IceServers[1]
	if len(turn.URLs) != 1 || turn.URLs[0] != "turn:relay:3478" {
		t.Errorf("TURN URLs = %v, want [turn:relay:3478]", turn.URLs)
	}
	if turn.Username != "user" || turn.Credential != "secret" {
		t.Errorf("TURN creds = (%q, %q), want (user, secret)", turn.Username, turn.Credential)
	}
}

func TestConfigLoad_LoggingOverrides(t *testing.T) {
	clearAppEnv(t)
	t.Setenv("LOG_LEVEL", "debug")
	t.Setenv("LOG_FORMAT", "text")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Load(): %v", err)
	}
	if cfg.Logging.Level != slog.LevelDebug {
		t.Errorf("Logging.Level = %v, want DEBUG", cfg.Logging.Level)
	}
	if cfg.Logging.Format != logging.FormatText {
		t.Errorf("Logging.Format = %q, want text", cfg.Logging.Format)
	}
}

func TestConfigLoad_RejectsBadLogging(t *testing.T) {
	t.Run("level", func(t *testing.T) {
		clearAppEnv(t)
		t.Setenv("LOG_LEVEL", "trace")
		if _, err := config.Load(); err == nil {
			t.Error("expected error for LOG_LEVEL=trace")
		}
	})
	t.Run("format", func(t *testing.T) {
		clearAppEnv(t)
		t.Setenv("LOG_FORMAT", "yaml")
		if _, err := config.Load(); err == nil {
			t.Error("expected error for LOG_FORMAT=yaml")
		}
	})
}

func TestConfigLoad_PortValidation(t *testing.T) {
	t.Run("valid", func(t *testing.T) {
		clearAppEnv(t)
		t.Setenv("SIGNALING_PORT", "9090")
		cfg, err := config.Load()
		if err != nil {
			t.Fatalf("Load(): %v", err)
		}
		if cfg.Server.Port != "9090" {
			t.Errorf("Server.Port = %q, want 9090", cfg.Server.Port)
		}
	})
	t.Run("invalid", func(t *testing.T) {
		clearAppEnv(t)
		t.Setenv("SIGNALING_PORT", "not-a-port")
		if _, err := config.Load(); err == nil {
			t.Error("expected error for SIGNALING_PORT=not-a-port")
		}
	})
}
