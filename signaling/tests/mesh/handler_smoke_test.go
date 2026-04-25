// Package mesh_test exercises the 002 mesh handler behind /ws/mesh.
// M1 scope: confirm a WebSocket upgrade succeeds and the connect /
// disconnect log entries are emitted. The 001 /ws path is exercised by
// signaling/tests/{handler_test.go,heartbeat_test.go}; this suite is
// strictly additive (plan §6.4).
package mesh_test

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"webrtc-lab/signaling/internal/mesh"
)

func silentLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

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

func meshURLFor(ts *httptest.Server) string {
	return "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws/mesh"
}

// TestMeshHandlerAcceptsWebSocketConnect — `wscat -c ws://.../ws/mesh`
// succeeds and the connect/disconnect log lines appear.
func TestMeshHandlerAcceptsWebSocketConnect(t *testing.T) {
	log, buf := captureLogger()
	h := mesh.NewHandler(log)
	ts := httptest.NewServer(h)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, meshURLFor(ts), nil)
	if err != nil {
		t.Fatalf("dial /ws/mesh failed: %v", err)
	}

	_ = conn.Close(websocket.StatusNormalClosure, "bye")

	// Allow the server goroutine to emit the disconnect log line.
	time.Sleep(50 * time.Millisecond)

	log.Info("flush") // force handler buffer to flush; harmless line.
	got := buf.String()
	for _, want := range []string{"mesh_ws_connected", "mesh_ws_disconnected"} {
		if !strings.Contains(got, want) {
			t.Errorf("expected log to contain %q; got:\n%s", want, got)
		}
	}
}

// TestMeshHandlerSilentLoggerDoesNotPanic guards against accidental nil
// logger dereference in the New constructor / handler hot path.
func TestMeshHandlerSilentLoggerDoesNotPanic(t *testing.T) {
	h := mesh.NewHandler(silentLogger())
	ts := httptest.NewServer(h)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, meshURLFor(ts), nil)
	if err != nil {
		t.Fatalf("dial failed: %v", err)
	}
	_ = conn.Close(websocket.StatusNormalClosure, "bye")
}
