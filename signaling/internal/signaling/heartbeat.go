package signaling

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"strconv"
	"time"

	"github.com/coder/websocket"
)

// Heartbeat config (contract §3.16). Defaults of 5s + 5s give a
// worst-case ungraceful-disconnect detection bound of ≤10s (SC-009).
type HeartbeatConfig struct {
	PingInterval time.Duration
	PongTimeout  time.Duration
}

// LoadHeartbeatConfig reads PING_INTERVAL_MS / PONG_TIMEOUT_MS from env
// and falls back to the 5000ms contract defaults.
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

// runHeartbeat runs the per-connection ping loop. It returns when the
// context is cancelled or a Ping fails / times out. The returned error
// carries a short reason suitable for ws_disconnected logs.
//
// Behavior:
//   - Every cfg.PingInterval, send a WebSocket Ping.
//   - Each Ping has cfg.PongTimeout for the peer to respond; if the
//     deadline fires, the connection is closed and the function returns
//     an error tagged "pong_timeout".
//
// This is purely the keep-alive layer. Application-level messages and
// the read loop live in handler.go.
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
					log.Info("heartbeat pong timeout",
						slog.String("event", "pong_timeout"),
						slog.String("conn_id", connID),
					)
					// CloseNow (not Close) — a Pong-timed-out peer is
					// by definition not reading, so a graceful close
					// handshake has no one to acknowledge it and would
					// stall until coder/websocket's close deadline
					// fires. That stall blocks the enclosing read loop,
					// delaying the deferred ServeHTTP cleanup
					// (releaseAndNotify) past SC-009's 10 s bound.
					// CloseNow sends a TCP FIN without waiting for a
					// close frame; the read loop unblocks immediately
					// and the classifier routes through
					// releaseAndNotify(cc, "disconnect") well under the
					// SC-009 budget.
					_ = conn.CloseNow()
					return &HeartbeatError{Reason: "pong_timeout"}
				}
				return &HeartbeatError{Reason: "ping_failed", Err: err}
			}
		}
	}
}

// HeartbeatError tags a heartbeat-loop termination with a stable
// machine-readable reason for ws_disconnected logs.
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
