package config

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"time"

	"webrtc-lab/signaling/internal/shared/heartbeat"
	"webrtc-lab/signaling/internal/shared/logging"
)

// Env is the validation/security profile the signaling server runs
// under. APP_ENV selects this; "dev" is the default.
//
// Behavior differences are NARROW and explicit — APP_ENV does not
// itself choose security policy. It only tightens validation:
//   - dev:  WS_ALLOWED_ORIGINS may be empty; if so, WebSocket Accept
//           runs with InsecureSkipVerify=true (any origin).
//   - prod: WS_ALLOWED_ORIGINS MUST be non-empty. Load() fails
//           otherwise. The actual OriginPatterns list comes from
//           that env var, never from APP_ENV alone.
type Env string

const (
	EnvDev  Env = "dev"
	EnvProd Env = "prod"
)

// AppConfig is the fully-validated runtime configuration for the
// signaling server. Built once at process start by Load(). Mode
// handlers MUST NOT receive AppConfig directly — they receive a
// ModeConfig slice via the per-mode field on ModesConfig.
type AppConfig struct {
	Env     Env
	Server  ServerConfig
	Logging logging.Config
	Shared  SharedConfig
	Modes   ModesConfig
}

// ServerConfig holds HTTP listener settings.
type ServerConfig struct {
	Port string // numeric, validated as 1..65535
}

// SharedConfig groups configuration consumed by infrastructure that
// every mode shares (heartbeat loop, ICE relay, WebSocket Accept).
type SharedConfig struct {
	Heartbeat  heartbeat.Config
	IceServers []IceServer
	WebSocket  WebSocketConfig
}

// WebSocketConfig captures the WebSocket Accept-time origin policy.
//
// Exactly one of InsecureSkipVerify or OriginPatterns is meaningful at
// runtime. coder/websocket.AcceptOptions semantics:
//   - InsecureSkipVerify=true: every origin is allowed.
//   - OriginPatterns non-empty: only those origins are allowed; same-
//     origin always allowed implicitly.
//
// Load() guarantees InsecureSkipVerify is false whenever OriginPatterns
// is non-empty, and that prod never gets InsecureSkipVerify=true.
type WebSocketConfig struct {
	InsecureSkipVerify bool
	OriginPatterns     []string
}

// ModeConfig is the per-mode subset handed to mode handlers. Today
// every mode receives identical values; the envelope exists so future
// mode-specific overrides have a natural slot without changing the
// handler signature.
type ModeConfig struct {
	Heartbeat  heartbeat.Config
	IceServers []IceServer
	WebSocket  WebSocketConfig
}

// ModesConfig holds the per-mode ModeConfig slices. Each mode handler
// receives only its own field, never the whole envelope.
type ModesConfig struct {
	OneToOne ModeConfig
	Mesh     ModeConfig
}

// Load reads the runtime configuration from the process environment
// and returns a fully-validated AppConfig. The caller (cmd/signaling)
// MUST exit non-zero on error BEFORE any logger setup, since the
// returned error is the only diagnostic available pre-logger.
func Load() (AppConfig, error) {
	env, err := loadEnv()
	if err != nil {
		return AppConfig{}, err
	}

	server, err := loadServer()
	if err != nil {
		return AppConfig{}, err
	}

	log, err := loadLogging()
	if err != nil {
		return AppConfig{}, err
	}

	hb, err := loadHeartbeat()
	if err != nil {
		return AppConfig{}, err
	}

	ws, err := loadWebSocket(env)
	if err != nil {
		return AppConfig{}, err
	}

	ice := loadIceServers()

	mode := ModeConfig{
		Heartbeat:  hb,
		IceServers: ice,
		WebSocket:  ws,
	}

	return AppConfig{
		Env:     env,
		Server:  server,
		Logging: log,
		Shared: SharedConfig{
			Heartbeat:  hb,
			IceServers: ice,
			WebSocket:  ws,
		},
		Modes: ModesConfig{
			OneToOne: mode,
			Mesh:     mode,
		},
	}, nil
}

func loadEnv() (Env, error) {
	raw := strings.ToLower(strings.TrimSpace(os.Getenv("APP_ENV")))
	switch raw {
	case "", "dev":
		return EnvDev, nil
	case "prod":
		return EnvProd, nil
	default:
		return "", fmt.Errorf("APP_ENV=%q is not valid; must be dev or prod", raw)
	}
}

func loadServer() (ServerConfig, error) {
	port := strings.TrimSpace(os.Getenv("SIGNALING_PORT"))
	if port == "" {
		port = "8080"
	}
	n, err := strconv.Atoi(port)
	if err != nil || n <= 0 || n > 65535 {
		return ServerConfig{}, fmt.Errorf("SIGNALING_PORT=%q is not a valid TCP port", port)
	}
	return ServerConfig{Port: port}, nil
}

func loadLogging() (logging.Config, error) {
	cfg := logging.Config{Level: slog.LevelInfo, Format: logging.FormatJSON}

	if raw := strings.ToLower(strings.TrimSpace(os.Getenv("LOG_LEVEL"))); raw != "" {
		switch raw {
		case "debug":
			cfg.Level = slog.LevelDebug
		case "info":
			cfg.Level = slog.LevelInfo
		case "warn", "warning":
			cfg.Level = slog.LevelWarn
		case "error":
			cfg.Level = slog.LevelError
		default:
			return logging.Config{}, fmt.Errorf("LOG_LEVEL=%q is not valid; must be debug|info|warn|error", raw)
		}
	}

	if raw := strings.ToLower(strings.TrimSpace(os.Getenv("LOG_FORMAT"))); raw != "" {
		switch raw {
		case "json":
			cfg.Format = logging.FormatJSON
		case "text":
			cfg.Format = logging.FormatText
		default:
			return logging.Config{}, fmt.Errorf("LOG_FORMAT=%q is not valid; must be json or text", raw)
		}
	}

	return cfg, nil
}

func loadHeartbeat() (heartbeat.Config, error) {
	ping, err := envPositiveDuration("PING_INTERVAL_MS", 5*time.Second)
	if err != nil {
		return heartbeat.Config{}, err
	}
	pong, err := envPositiveDuration("PONG_TIMEOUT_MS", 5*time.Second)
	if err != nil {
		return heartbeat.Config{}, err
	}
	return heartbeat.Config{PingInterval: ping, PongTimeout: pong}, nil
}

func envPositiveDuration(key string, def time.Duration) (time.Duration, error) {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return def, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return 0, fmt.Errorf("%s=%q must be a positive integer (milliseconds)", key, raw)
	}
	return time.Duration(n) * time.Millisecond, nil
}

func loadWebSocket(env Env) (WebSocketConfig, error) {
	raw := strings.TrimSpace(os.Getenv("WS_ALLOWED_ORIGINS"))
	var origins []string
	if raw != "" {
		for _, o := range strings.Split(raw, ",") {
			if t := strings.TrimSpace(o); t != "" {
				origins = append(origins, t)
			}
		}
	}
	if env == EnvProd && len(origins) == 0 {
		return WebSocketConfig{}, errors.New("WS_ALLOWED_ORIGINS is required when APP_ENV=prod (comma-separated origin list)")
	}
	if len(origins) > 0 {
		return WebSocketConfig{OriginPatterns: origins}, nil
	}
	return WebSocketConfig{InsecureSkipVerify: true}, nil
}

// loadIceServers reads the ICE_* env keys and returns the list relayed
// to clients via mode-specific signaling payloads. ICE was renamed
// from VITE_* (which was misleading; only the backend reads these).
//
// TURN credentials MUST never be logged (NFR-003); this loader does
// not log.
func loadIceServers() []IceServer {
	var servers []IceServer
	if raw := strings.TrimSpace(os.Getenv("ICE_STUN_URLS")); raw != "" {
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
	if turn := strings.TrimSpace(os.Getenv("ICE_TURN_URL")); turn != "" {
		servers = append(servers, IceServer{
			URLs:       []string{turn},
			Username:   os.Getenv("ICE_TURN_USERNAME"),
			Credential: os.Getenv("ICE_TURN_CREDENTIAL"),
		})
	}
	return servers
}
