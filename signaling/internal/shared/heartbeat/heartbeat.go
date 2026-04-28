// Package heartbeat is the shared WebSocket keep-alive loop used by
// every mode's signaling handler. It defines a single per-connection
// ping cadence (5 s default) with a per-ping pong timeout (5 s
// default) so the worst-case ungraceful-disconnect detection bound is
// ≤10 s. Identical timing constants for 001 and mesh; one env source
// governs both.
//
// Each mode customizes the observable log strings via Labels — the
// loop body itself is shared. Behavior preserved verbatim from the
// pre-refactor `signaling/heartbeat.go` and `mesh/heartbeat.go`:
// emits a single slog.Info call on pong timeout (no per-ping log),
// returns `&HeartbeatError{Reason: "pong_timeout"}` after CloseNow(),
// returns `&HeartbeatError{Reason: "ping_failed", Err: err}` for any
// other Ping error.
package heartbeat

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"strconv"
	"time"

	"github.com/coder/websocket"
)

// Config holds the ping cadence + pong-timeout. Loaded from env via
// `LoadFromEnv()`. Type matches the pre-refactor `HeartbeatConfig`
// shape verbatim (Duration, not int milliseconds).
type Config struct {
	PingInterval time.Duration
	PongTimeout  time.Duration
}

// Labels carry the per-mode observable strings: the slog `event`
// field and the message text on the single pong-timeout log call.
// Both modes preserved verbatim:
//   - 001:  Event="pong_timeout"        Message="heartbeat pong timeout"
//   - mesh: Event="mesh_pong_timeout"   Message="mesh heartbeat pong timeout"
type Labels struct {
	PongTimeoutEvent   string
	PongTimeoutMessage string
}

// HeartbeatError tags loop termination with a stable machine-readable
// reason for ws_disconnected logs. Shape matches pre-refactor
// `HeartbeatError` verbatim: `Reason string; Err error` + `Unwrap()`
// so callers can `errors.Is/As`.
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

// LoadFromEnv reads PING_INTERVAL_MS / PONG_TIMEOUT_MS from env and
// falls back to the 5000 ms contract default. Identical behavior to
// the pre-refactor `LoadHeartbeatConfig` in 001 and mesh.
func LoadFromEnv() Config {
	return Config{
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

// Run sends a WebSocket Ping every cfg.PingInterval and waits up to
// cfg.PongTimeout for the auto-Pong. On timeout, calls CloseNow()
// (NOT Close — the peer is by definition not reading, so a graceful
// close handshake would stall) and returns a `pong_timeout`-tagged
// HeartbeatError. The single slog.Info call uses labels.PongTimeout*
// so each mode's log lines are preserved verbatim.
func Run(
	ctx context.Context,
	conn *websocket.Conn,
	cfg Config,
	log *slog.Logger,
	connID string,
	labels Labels,
) error {
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
					log.Info(labels.PongTimeoutMessage,
						slog.String("event", labels.PongTimeoutEvent),
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
