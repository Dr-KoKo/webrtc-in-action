// Shared-heartbeat observable-behavior tests.
//
// Locks in two invariants for `internal/shared/heartbeat`:
//   1. The single pong-timeout slog.Info call uses the supplied
//      `Labels.PongTimeoutMessage` and `Labels.PongTimeoutEvent` —
//      preserving the per-mode log strings that 001 (`pong_timeout` /
//      `heartbeat pong timeout`) and mesh (`mesh_pong_timeout` /
//      `mesh heartbeat pong timeout`) emitted before the extraction.
//   2. `HeartbeatError{Reason: "pong_timeout", Err: nil}` is returned
//      with `Unwrap()` returning nil; the inner error is preserved on
//      the `ping_failed` path (covered indirectly by mode-level tests).
//
// Test method: stand up an httptest server that runs the shared
// heartbeat loop with very short intervals; refuse to pump the
// client's read loop so the server's Ping accumulates without a Pong;
// the loop hits the timeout path and emits the labeled log line.
package tests

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"webrtc-lab/signaling/internal/shared/heartbeat"
)

type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buf.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buf.String()
}

func captureLogger() (*slog.Logger, *syncBuffer) {
	buf := &syncBuffer{}
	return slog.New(slog.NewJSONHandler(buf, nil)), buf
}

func newHeartbeatServer(t *testing.T, labels heartbeat.Labels, log *slog.Logger) (*httptest.Server, <-chan error) {
	t.Helper()
	done := make(chan error, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			done <- err
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		defer cancel()
		err = heartbeat.Run(ctx, conn, heartbeat.Config{
			PingInterval: 30 * time.Millisecond,
			PongTimeout:  60 * time.Millisecond,
		}, log, "test-conn", labels)
		_ = conn.Close(websocket.StatusNormalClosure, "bye")
		done <- err
	}))
	return srv, done
}

func wsURL(ts *httptest.Server) string {
	return "ws" + strings.TrimPrefix(ts.URL, "http")
}

// pumpUntilPongTimeout dials the WS and refuses to read, forcing the
// server's Ping to time out without a Pong. Returns when the heartbeat
// goroutine's `done` channel resolves.
func pumpUntilPongTimeout(t *testing.T, ts *httptest.Server, done <-chan error) error {
	t.Helper()
	dialCtx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(dialCtx, wsURL(ts), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.CloseNow()
	select {
	case err := <-done:
		return err
	case <-time.After(2 * time.Second):
		t.Fatalf("heartbeat did not return within 2 s")
		return nil
	}
}

func TestRunPongTimeoutEmitsOneToOneLabels(t *testing.T) {
	labels := heartbeat.Labels{
		PongTimeoutEvent:   "pong_timeout",
		PongTimeoutMessage: "heartbeat pong timeout",
	}
	log, buf := captureLogger()
	ts, done := newHeartbeatServer(t, labels, log)
	defer ts.Close()
	err := pumpUntilPongTimeout(t, ts, done)

	var hbErr *heartbeat.HeartbeatError
	if !errors.As(err, &hbErr) {
		t.Fatalf("expected HeartbeatError, got %v (%T)", err, err)
	}
	if hbErr.Reason != "pong_timeout" {
		t.Fatalf("Reason = %q; want pong_timeout", hbErr.Reason)
	}
	if hbErr.Unwrap() != nil {
		t.Fatalf("Unwrap = %v; want nil on pong_timeout", hbErr.Unwrap())
	}
	logStr := buf.String()
	if !strings.Contains(logStr, `"event":"pong_timeout"`) {
		t.Errorf("log missing pong_timeout event: %s", logStr)
	}
	if !strings.Contains(logStr, `"msg":"heartbeat pong timeout"`) {
		t.Errorf("log missing 'heartbeat pong timeout' message: %s", logStr)
	}
}

func TestRunPongTimeoutEmitsMeshLabels(t *testing.T) {
	labels := heartbeat.Labels{
		PongTimeoutEvent:   "mesh_pong_timeout",
		PongTimeoutMessage: "mesh heartbeat pong timeout",
	}
	log, buf := captureLogger()
	ts, done := newHeartbeatServer(t, labels, log)
	defer ts.Close()
	err := pumpUntilPongTimeout(t, ts, done)

	var hbErr *heartbeat.HeartbeatError
	if !errors.As(err, &hbErr) {
		t.Fatalf("expected HeartbeatError, got %v (%T)", err, err)
	}
	if hbErr.Reason != "pong_timeout" {
		t.Fatalf("Reason = %q; want pong_timeout (mesh log labels are independent of Reason)", hbErr.Reason)
	}
	logStr := buf.String()
	if !strings.Contains(logStr, `"event":"mesh_pong_timeout"`) {
		t.Errorf("log missing mesh_pong_timeout event: %s", logStr)
	}
	if !strings.Contains(logStr, `"msg":"mesh heartbeat pong timeout"`) {
		t.Errorf("log missing 'mesh heartbeat pong timeout' message: %s", logStr)
	}
}

func TestLoadFromEnvDefaults(t *testing.T) {
	t.Setenv("PING_INTERVAL_MS", "")
	t.Setenv("PONG_TIMEOUT_MS", "")
	cfg := heartbeat.LoadFromEnv()
	if cfg.PingInterval != 5*time.Second || cfg.PongTimeout != 5*time.Second {
		t.Fatalf("defaults = (%v, %v); want (5s, 5s)", cfg.PingInterval, cfg.PongTimeout)
	}
}

func TestLoadFromEnvOverrides(t *testing.T) {
	t.Setenv("PING_INTERVAL_MS", "1234")
	t.Setenv("PONG_TIMEOUT_MS", "5678")
	cfg := heartbeat.LoadFromEnv()
	if cfg.PingInterval != 1234*time.Millisecond {
		t.Fatalf("PingInterval = %v; want 1234ms", cfg.PingInterval)
	}
	if cfg.PongTimeout != 5678*time.Millisecond {
		t.Fatalf("PongTimeout = %v; want 5678ms", cfg.PongTimeout)
	}
}

// silentLogger placeholder so the file compiles even if some tests
// don't need the captured one.
var _ = io.Discard
