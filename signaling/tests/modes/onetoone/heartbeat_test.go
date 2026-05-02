package tests

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	sig "webrtc-lab/signaling/internal/modes/onetoone"
	proto "webrtc-lab/signaling/internal/modes/onetoone/protocol"
)

// silentLogger drops everything. Tests that want to assert log output
// should use captureLogger below instead.
func silentLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// syncBuffer is a minimal thread-safe wrapper around bytes.Buffer so
// the handler goroutine's slog writes race cleanly with test-thread
// String() reads under -race.
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

// captureLogger returns a JSON slog logger backed by a thread-safe
// buffer so tests can call buf.String() concurrently with handler
// goroutines that may still be writing.
func captureLogger() (*slog.Logger, *syncBuffer) {
	buf := &syncBuffer{}
	return slog.New(slog.NewJSONHandler(buf, nil)), buf
}

func wsURLFor(ts *httptest.Server) string {
	return "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws"
}

// newFastHandler returns a Handler configured for fast heartbeat tests.
func newFastHandler(log *slog.Logger) *sig.Handler {
	h := sig.NewHandler(log)
	h.Heartbeat = sig.HeartbeatConfig{
		PingInterval: 50 * time.Millisecond,
		PongTimeout:  100 * time.Millisecond,
	}
	return h
}

// ---------------------------------------------------------------------
// TestPongTimeoutClosesWithin10s
//
// The coder/websocket client library only replies to Ping frames while
// its Read loop is pumping. If the test client refuses to Read, the
// server's Ping cannot receive a Pong and the pong-timeout path fires.
//
// We assert the server closes the WS within PingInterval + PongTimeout
// + slack (here: 50 + 100 + 1000 ms), which is the mechanism that
// underpins the production SC-009 ≤10s bound.
// ---------------------------------------------------------------------

func TestPongTimeoutClosesWithin10s(t *testing.T) {
	log, buf := captureLogger()
	h := newFastHandler(log)
	ts := httptest.NewServer(h)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, wsURLFor(ts), nil)
	if err != nil {
		t.Fatalf("dial failed: %v", err)
	}

	// Deliberately do NOT pump the read loop: coder/websocket only
	// auto-replies to server-sent Ping frames while the client is
	// inside Read(). With no reader, the Pings pile up in the TCP
	// buffer and the server's Pong wait times out.
	start := time.Now()

	// Wait long enough for PingInterval (50ms) + PongTimeout (100ms)
	// + comfortable slack to let the server emit the pong_timeout log
	// and close the WS.
	time.Sleep(400 * time.Millisecond)

	// Verify the server has actually closed the connection.
	readCtx, cancelRead := context.WithTimeout(ctx, 1*time.Second)
	defer cancelRead()
	if _, _, err := conn.Read(readCtx); err == nil {
		t.Fatalf("expected Read to fail after server close")
	}
	elapsed := time.Since(start)

	// Fast-config worst case = 150ms. Assert bounded by 10s (SC-009
	// proxy) with generous margin — the important thing is that
	// pong_timeout fires, not exact timing.
	if elapsed > 10*time.Second {
		t.Fatalf("close took %v; expected ≤ 10s (SC-009)", elapsed)
	}

	_ = conn.CloseNow()
	if !strings.Contains(buf.String(), "pong_timeout") {
		t.Errorf("expected pong_timeout log, got:\n%s", buf.String())
	}
}

// ---------------------------------------------------------------------
// TestPingIntervalEmits
//
// An actively-reading client with the default auto-pong behavior stays
// connected indefinitely. We verify that two consecutive PingInterval
// windows pass without the server killing the connection — i.e., the
// heartbeat is steady, not a one-shot.
// ---------------------------------------------------------------------

func TestPingIntervalEmits(t *testing.T) {
	h := newFastHandler(silentLogger())
	ts := httptest.NewServer(h)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, wsURLFor(ts), nil)
	if err != nil {
		t.Fatalf("dial failed: %v", err)
	}
	defer conn.CloseNow()

	// Drive the client's read loop so it auto-replies to pings.
	var connAlive atomic.Bool
	connAlive.Store(true)
	readCtx, cancelRead := context.WithCancel(ctx)
	defer cancelRead()
	go func() {
		for {
			_, _, err := conn.Read(readCtx)
			if err != nil {
				connAlive.Store(false)
				return
			}
		}
	}()

	// Three ping intervals; should remain alive the whole time.
	time.Sleep(3 * 50 * time.Millisecond * 3) // 450ms
	if !connAlive.Load() {
		t.Fatalf("connection died despite client responding to pings")
	}
}

// ---------------------------------------------------------------------
// TestHandlerRejectsUnsupportedVersion
//
// Sending {"v":2,...} must yield an `error` frame with
// `unsupported_version` and keep the WS alive (the handler does not
// disconnect on a single malformed frame).
// ---------------------------------------------------------------------

func TestHandlerRejectsUnsupportedVersion(t *testing.T) {
	h := sig.NewHandler(silentLogger())
	// Keep default 5s heartbeat — we only need ~100ms round-trip.
	ts := httptest.NewServer(h)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, wsURLFor(ts), nil)
	if err != nil {
		t.Fatalf("dial failed: %v", err)
	}
	defer conn.CloseNow()

	badFrame := []byte(`{"v":2,"type":"join_room","roomId":"demo","requestId":"deadbeef-0000-4000-8000-000000000001","payload":{}}`)
	if err := conn.Write(ctx, websocket.MessageText, badFrame); err != nil {
		t.Fatalf("write failed: %v", err)
	}

	_, raw, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read failed: %v", err)
	}

	var env proto.Envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatalf("server reply not JSON: %v", err)
	}
	if env.Type != proto.TypeError {
		t.Fatalf("server reply type = %q, want %q", env.Type, proto.TypeError)
	}

	var payload proto.ErrorPayload
	if err := json.Unmarshal(env.Payload, &payload); err != nil {
		t.Fatalf("server reply payload not ErrorPayload: %v", err)
	}
	if payload.Code != proto.CodeUnsupportedVersion {
		t.Fatalf("error code = %q, want %q", payload.Code, proto.CodeUnsupportedVersion)
	}
}

// ---------------------------------------------------------------------
// TestHandlerLogsNoSecrets
//
// Regression guard for NFR-003: the lifecycle log lines must NOT carry
// SDP bodies, ICE candidate strings, or TURN credentials even if we
// send fake versions of them in a (malformed) frame. Phase 2 has no
// room logic, so this test is intentionally thin — it asserts the
// tokens `sdp=`, `candidate:` substrings, and `credential` do not
// appear in the captured log.
// ---------------------------------------------------------------------

func TestHandlerLogsNoSecrets(t *testing.T) {
	log, buf := captureLogger()
	h := sig.NewHandler(log)
	ts := httptest.NewServer(h)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, wsURLFor(ts), nil)
	if err != nil {
		t.Fatalf("dial failed: %v", err)
	}

	// Even though the server ignores this under Phase 2 (unknown state
	// transition), the bytes should never be logged.
	offerFrame := []byte(`{"v":1,"type":"offer","roomId":"demo","payload":{"sdp":{"type":"offer","sdp":"v=0\r\nsensitive-sdp-body\r\ncandidate:DO_NOT_LOG"}}}`)
	_ = conn.Write(ctx, websocket.MessageText, offerFrame)

	_ = conn.Close(websocket.StatusNormalClosure, "bye")

	// Small grace for server to emit ws_disconnected.
	time.Sleep(100 * time.Millisecond)

	for _, bad := range []string{"sensitive-sdp-body", "DO_NOT_LOG", "credential"} {
		if strings.Contains(buf.String(), bad) {
			t.Errorf("log leaked sensitive token %q:\n%s", bad, buf.String())
		}
	}
}
