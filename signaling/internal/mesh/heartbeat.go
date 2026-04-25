package mesh

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"strconv"
	"time"

	"github.com/coder/websocket"
)

// HeartbeatConfig — contract §3.20. Defaults of 5 s + 5 s give a
// worst-case ungraceful-disconnect detection bound of ≤10 s (SC-005a).
// Identical values are read by the 001 server; both sides use the same
// env keys (`PING_INTERVAL_MS` / `PONG_TIMEOUT_MS`) so a single env
// configuration governs both endpoints.
type HeartbeatConfig struct {
	PingInterval time.Duration
	PongTimeout  time.Duration
}

// LoadHeartbeatConfig reads PING_INTERVAL_MS / PONG_TIMEOUT_MS from env
// and falls back to the 5000 ms contract defaults.
func LoadHeartbeatConfig() HeartbeatConfig {
	return HeartbeatConfig{
		PingInterval: envDuration("PING_INTERVAL_MS", 5*time.Second),
		PongTimeout:  envDuration("PONG_TIMEOUT_MS", 5*time.Second),
	}
}

func envDuration(key string, def time.Duration) time.Duration {
	raw := os.Getenv(key)
	if raw == "" {
		return def
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return def
	}
	return time.Duration(n) * time.Millisecond
}

// HeartbeatError tags the heartbeat-loop termination with a stable
// machine-readable reason for `mesh_ws_disconnected` logs.
type HeartbeatError struct {
	Reason string
	Err    error
}

func (e *HeartbeatError) Error() string {
	if e.Err != nil {
		return e.Reason + ": " + e.Err.Error()
	}
	return e.Reason
}

func (e *HeartbeatError) Unwrap() error { return e.Err }

// runHeartbeat sends WebSocket Ping frames every cfg.PingInterval and
// waits up to cfg.PongTimeout for the auto-Pong. Behavior mirrors the
// 001 `runHeartbeat` (plan §6.4 — shared timing constants), kept as a
// separate function in this package so the 001 helper does not need to
// expose itself across packages.
func runHeartbeat(ctx context.Context, conn *websocket.Conn, cfg HeartbeatConfig, log *slog.Logger, connID string) error {
	ticker := time.NewTicker(cfg.PingInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			pingCtx, cancel := context.WithTimeout(ctx, cfg.PongTimeout)
			err := conn.Ping(pingCtx)
			cancel()
			if err != nil {
				if errors.Is(err, context.DeadlineExceeded) {
					log.Info("mesh heartbeat pong timeout",
						slog.String("event", "mesh_pong_timeout"),
						slog.String("conn_id", connID),
					)
					_ = conn.CloseNow()
					return &HeartbeatError{Reason: "pong_timeout"}
				}
				return &HeartbeatError{Reason: "ping_failed", Err: err}
			}
		}
	}
}
