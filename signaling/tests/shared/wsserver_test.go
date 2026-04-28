package tests

// wsserver_test.go — integration tests for
// internal/shared/wsserver, exercising the API contract with a
// fake Mode. These tests gate Phase 1 of the WebSocket transport
// extraction. See plan:
// /home/lw/.claude/plans/make-plan-analyze-code-dazzling-perlis.md

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"webrtc-lab/signaling/internal/shared/heartbeat"
	"webrtc-lab/signaling/internal/shared/wsserver"
)

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

type syncBuf struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (s *syncBuf) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buf.Write(p)
}

func (s *syncBuf) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buf.String()
}

func captureLog() (*slog.Logger, *syncBuf) {
	b := &syncBuf{}
	return slog.New(slog.NewJSONHandler(b, nil)), b
}

func silentLog() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func wsURLForServer(ts *httptest.Server) string {
	return "ws" + strings.TrimPrefix(ts.URL, "http") + "/"
}

// fakeMode is a Mode whose NewSession behavior is driven by a
// closure; the returned SessionHandler delegates HandleFrame and
// OnDisconnect to provided closures.
type fakeMode struct {
	newSession func(sess wsserver.Session, log *slog.Logger) (wsserver.SessionHandler, error)
}

func (m *fakeMode) NewSession(sess wsserver.Session, log *slog.Logger) (wsserver.SessionHandler, error) {
	return m.newSession(sess, log)
}

type fakeSessionHandler struct {
	handleFrame  func(ctx context.Context, frame []byte) error
	onDisconnect func(reason string) []slog.Attr

	disconnectCount atomic.Int32
	lastReason      atomic.Value // string
	frameCount      atomic.Int32
}

func (h *fakeSessionHandler) HandleFrame(ctx context.Context, frame []byte) error {
	h.frameCount.Add(1)
	if h.handleFrame == nil {
		return nil
	}
	return h.handleFrame(ctx, frame)
}

func (h *fakeSessionHandler) OnDisconnect(reason string) []slog.Attr {
	h.disconnectCount.Add(1)
	h.lastReason.Store(reason)
	if h.onDisconnect == nil {
		return nil
	}
	return h.onDisconnect(reason)
}

// fastHB returns a heartbeat config tuned for tests that exercise
// pong timeout in <1 s.
func fastHB() heartbeat.Config {
	return heartbeat.Config{
		PingInterval: 50 * time.Millisecond,
		PongTimeout:  100 * time.Millisecond,
	}
}

func defaultCfg(log *slog.Logger, hb *heartbeat.Config) wsserver.Config {
	return wsserver.Config{
		Heartbeat:       hb,
		HeartbeatLabels: heartbeat.Labels{PongTimeoutEvent: "fake_pong_timeout", PongTimeoutMessage: "fake heartbeat pong timeout"},
		Logger:          log,
		Accept:          &websocket.AcceptOptions{InsecureSkipVerify: true},
		ConnIDPrefix:    "f-",
		Connect:         wsserver.LogLine{Event: "fake_ws_connected", Message: "fake websocket connected"},
		Disconnect:      wsserver.LogLine{Event: "fake_ws_disconnected", Message: "fake websocket disconnected"},
		AcceptFailed:    wsserver.LogLine{Event: "fake_ws_accept_failed", Message: "fake websocket accept failed"},
	}
}

func findLogLine(captured, eventValue string) map[string]any {
	for _, line := range strings.Split(captured, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var rec map[string]any
		if err := json.Unmarshal([]byte(line), &rec); err != nil {
			continue
		}
		if rec["event"] == eventValue {
			return rec
		}
	}
	return nil
}

// ---------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------

// 1. Clean peer close — client sends graceful close; reason on
//    disconnect log = peer_close; OnDisconnect runs with same value.
func TestWsserver_CleanPeerClose(t *testing.T) {
	log, buf := captureLog()
	hb := heartbeat.Config{PingInterval: 5 * time.Second, PongTimeout: 5 * time.Second}

	handler := &fakeSessionHandler{}
	mode := &fakeMode{newSession: func(_ wsserver.Session, _ *slog.Logger) (wsserver.SessionHandler, error) {
		return handler, nil
	}}
	srv := wsserver.New(mode, defaultCfg(log, &hb))
	ts := httptest.NewServer(srv)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, wsURLForServer(ts), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	_ = conn.Close(websocket.StatusNormalClosure, "bye")

	time.Sleep(150 * time.Millisecond)

	captured := buf.String()
	rec := findLogLine(captured, "fake_ws_disconnected")
	if rec == nil {
		t.Fatalf("no disconnect log; captured:\n%s", captured)
	}
	if rec["reason"] != "peer_close" {
		t.Errorf("expected reason=peer_close, got %v", rec["reason"])
	}
	if rec["remote_addr"] != nil {
		t.Errorf("disconnect log must NOT contain remote_addr; got %v", rec["remote_addr"])
	}
	if got := handler.disconnectCount.Load(); got != 1 {
		t.Errorf("OnDisconnect call count = %d, want 1", got)
	}
	if got := handler.lastReason.Load(); got != "peer_close" {
		t.Errorf("OnDisconnect reason = %v, want peer_close", got)
	}
}

// 2. Pong timeout — fast heartbeat; no auto-pong; reason =
//    "read_error" (per characterization tests in
//    tests/modes/{onetoone,mesh}/lifecycle_test.go); heartbeat
//    pong-timeout event logged; Session.Close after heartbeat's
//    CloseNow does not produce an error log.
func TestWsserver_PongTimeoutClassifiedAsReadError(t *testing.T) {
	log, buf := captureLog()
	hb := fastHB()

	handler := &fakeSessionHandler{}
	mode := &fakeMode{newSession: func(_ wsserver.Session, _ *slog.Logger) (wsserver.SessionHandler, error) {
		return handler, nil
	}}
	srv := wsserver.New(mode, defaultCfg(log, &hb))
	ts := httptest.NewServer(srv)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, wsURLForServer(ts), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.CloseNow()

	time.Sleep(400 * time.Millisecond)
	readCtx, cancelRead := context.WithTimeout(ctx, 1*time.Second)
	defer cancelRead()
	_, _, _ = conn.Read(readCtx)
	time.Sleep(200 * time.Millisecond)

	captured := buf.String()
	rec := findLogLine(captured, "fake_ws_disconnected")
	if rec == nil {
		t.Fatalf("no disconnect log; captured:\n%s", captured)
	}
	if rec["reason"] != "read_error" {
		t.Errorf("expected reason=read_error (readErr-beats-hbErr precedence), got %v", rec["reason"])
	}
	if !strings.Contains(captured, "\"event\":\"fake_pong_timeout\"") {
		t.Errorf("expected fake_pong_timeout heartbeat log; captured:\n%s", captured)
	}
	if strings.Contains(captured, "close failed") {
		t.Errorf("Session.Close after heartbeat CloseNow surfaced an error; captured:\n%s", captured)
	}
}

// 3. Write serialization — concurrent goroutines calling
//    Session.Send must not interleave or panic.
func TestWsserver_WriteSerialization(t *testing.T) {
	hb := heartbeat.Config{PingInterval: 5 * time.Second, PongTimeout: 5 * time.Second}

	const writers = 16
	const perWriter = 8

	var sessRef atomic.Value // wsserver.Session
	ready := make(chan struct{})
	var sendDone sync.WaitGroup

	mode := &fakeMode{newSession: func(sess wsserver.Session, _ *slog.Logger) (wsserver.SessionHandler, error) {
		sessRef.Store(sess)
		close(ready)
		return &fakeSessionHandler{}, nil
	}}
	srv := wsserver.New(mode, defaultCfg(silentLog(), &hb))
	ts := httptest.NewServer(srv)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, wsURLForServer(ts), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.CloseNow()

	<-ready
	sess, _ := sessRef.Load().(wsserver.Session)
	if sess == nil {
		t.Fatalf("Session not captured")
	}

	// Hammer Send from many goroutines.
	sendDone.Add(writers)
	for i := 0; i < writers; i++ {
		i := i
		go func() {
			defer sendDone.Done()
			for j := 0; j < perWriter; j++ {
				payload := []byte(`{"writer":` + strconv.Itoa(i) + `,"j":` + strconv.Itoa(j) + `}`)
				if err := sess.Send(sess.BaseContext(), payload); err != nil {
					return
				}
			}
		}()
	}

	// Drain reads on the client side so writes don't backpressure.
	got := atomic.Int64{}
	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		for {
			_, _, err := conn.Read(ctx)
			if err != nil {
				return
			}
			got.Add(1)
		}
	}()

	sendDone.Wait()
	// Allow last reads to drain.
	time.Sleep(150 * time.Millisecond)

	if n := got.Load(); n != int64(writers*perWriter) {
		t.Errorf("expected %d frames, got %d", writers*perWriter, n)
	}

	_ = conn.Close(websocket.StatusNormalClosure, "bye")
	<-readDone
}

// 4. Graceful close from inside HandleFrame — Session.Close called
//    while read loop is active; teardown's Close is a no-op.
func TestWsserver_CloseFromHandleFrameThenTeardown(t *testing.T) {
	log, buf := captureLog()
	hb := heartbeat.Config{PingInterval: 5 * time.Second, PongTimeout: 5 * time.Second}

	var sessRef atomic.Value
	handler := &fakeSessionHandler{
		handleFrame: func(_ context.Context, _ []byte) error {
			sess := sessRef.Load().(wsserver.Session)
			_ = sess.Close(websocket.StatusNormalClosure, "graceful_leave")
			return nil
		},
	}
	mode := &fakeMode{newSession: func(sess wsserver.Session, _ *slog.Logger) (wsserver.SessionHandler, error) {
		sessRef.Store(sess)
		return handler, nil
	}}
	srv := wsserver.New(mode, defaultCfg(log, &hb))
	ts := httptest.NewServer(srv)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, wsURLForServer(ts), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.CloseNow()

	if err := conn.Write(ctx, websocket.MessageText, []byte(`{"hi":1}`)); err != nil {
		t.Fatalf("write: %v", err)
	}
	_, _, _ = conn.Read(ctx)
	time.Sleep(150 * time.Millisecond)

	captured := buf.String()
	if got := strings.Count(captured, "\"event\":\"fake_ws_disconnected\""); got != 1 {
		t.Errorf("expected exactly 1 disconnect log, got %d; captured:\n%s", got, captured)
	}
	if strings.Contains(captured, "close failed") {
		t.Errorf("teardown Close after in-frame Close surfaced an error; captured:\n%s", captured)
	}
	if got := handler.disconnectCount.Load(); got != 1 {
		t.Errorf("OnDisconnect call count = %d, want 1", got)
	}
}

// 5. OnDisconnect attrs flow into the disconnect log line.
func TestWsserver_OnDisconnectAttrs(t *testing.T) {
	log, buf := captureLog()
	hb := heartbeat.Config{PingInterval: 5 * time.Second, PongTimeout: 5 * time.Second}

	handler := &fakeSessionHandler{
		onDisconnect: func(reason string) []slog.Attr {
			return []slog.Attr{
				slog.String("peer_id", "p-test"),
				slog.Int("admission_order", 7),
			}
		},
	}
	mode := &fakeMode{newSession: func(_ wsserver.Session, _ *slog.Logger) (wsserver.SessionHandler, error) {
		return handler, nil
	}}
	srv := wsserver.New(mode, defaultCfg(log, &hb))
	ts := httptest.NewServer(srv)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, wsURLForServer(ts), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	_ = conn.Close(websocket.StatusNormalClosure, "bye")
	time.Sleep(150 * time.Millisecond)

	captured := buf.String()
	rec := findLogLine(captured, "fake_ws_disconnected")
	if rec == nil {
		t.Fatalf("no disconnect log; captured:\n%s", captured)
	}
	if rec["peer_id"] != "p-test" {
		t.Errorf("expected peer_id=p-test in disconnect log, got %v", rec["peer_id"])
	}
	// JSON unmarshals numbers as float64.
	if got, _ := rec["admission_order"].(float64); got != 7 {
		t.Errorf("expected admission_order=7, got %v", rec["admission_order"])
	}
}

// 6. NewSession refusal contract.
func TestWsserver_NewSessionRefusal(t *testing.T) {
	log, buf := captureLog()
	hb := heartbeat.Config{PingInterval: 5 * time.Second, PongTimeout: 5 * time.Second}

	frameCount := atomic.Int32{}
	disconnectCount := atomic.Int32{}
	mode := &fakeMode{newSession: func(_ wsserver.Session, _ *slog.Logger) (wsserver.SessionHandler, error) {
		// Capture refusal-time hooks on a never-returned handler so we
		// can prove HandleFrame / OnDisconnect on it never fire.
		_ = &fakeSessionHandler{
			handleFrame:  func(_ context.Context, _ []byte) error { frameCount.Add(1); return nil },
			onDisconnect: func(_ string) []slog.Attr { disconnectCount.Add(1); return nil },
		}
		return nil, errors.New("synthetic refusal")
	}}
	srv := wsserver.New(mode, defaultCfg(log, &hb))
	ts := httptest.NewServer(srv)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, wsURLForServer(ts), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.CloseNow()

	// Server should close almost immediately. Wait for it.
	readCtx, cancelRead := context.WithTimeout(ctx, 1*time.Second)
	defer cancelRead()
	_, _, _ = conn.Read(readCtx)
	time.Sleep(150 * time.Millisecond)

	captured := buf.String()
	if !strings.Contains(captured, "\"event\":\"fake_ws_connected\"") {
		t.Errorf("connect log MUST be emitted before refusal; captured:\n%s", captured)
	}
	rec := findLogLine(captured, "fake_ws_disconnected")
	if rec == nil {
		t.Fatalf("no disconnect log; captured:\n%s", captured)
	}
	if rec["reason"] != "newsession_refused" {
		t.Errorf("expected reason=newsession_refused, got %v", rec["reason"])
	}
	if rec["refuse_error"] != "synthetic refusal" {
		t.Errorf("expected refuse_error=synthetic refusal, got %v", rec["refuse_error"])
	}
	if frameCount.Load() != 0 {
		t.Errorf("HandleFrame must not be called on refusal path")
	}
	if disconnectCount.Load() != 0 {
		t.Errorf("OnDisconnect must not be called on refusal path")
	}
}

// 7. Non-nil HandleFrame return is terminal.
func TestWsserver_NonNilHandleFrameTerminates(t *testing.T) {
	log, buf := captureLog()
	hb := heartbeat.Config{PingInterval: 5 * time.Second, PongTimeout: 5 * time.Second}

	handler := &fakeSessionHandler{
		handleFrame: func(_ context.Context, _ []byte) error {
			return errors.New("synthetic terminal")
		},
	}
	mode := &fakeMode{newSession: func(_ wsserver.Session, _ *slog.Logger) (wsserver.SessionHandler, error) {
		return handler, nil
	}}
	srv := wsserver.New(mode, defaultCfg(log, &hb))
	ts := httptest.NewServer(srv)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, wsURLForServer(ts), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.CloseNow()

	if err := conn.Write(ctx, websocket.MessageText, []byte(`{"x":1}`)); err != nil {
		t.Fatalf("write: %v", err)
	}
	_, _, _ = conn.Read(ctx)
	time.Sleep(150 * time.Millisecond)

	captured := buf.String()
	rec := findLogLine(captured, "fake_ws_disconnected")
	if rec == nil {
		t.Fatalf("no disconnect log; captured:\n%s", captured)
	}
	if got := handler.frameCount.Load(); got != 1 {
		t.Errorf("HandleFrame call count = %d, want 1", got)
	}
	if got := handler.disconnectCount.Load(); got != 1 {
		t.Errorf("OnDisconnect call count = %d, want 1", got)
	}
}
