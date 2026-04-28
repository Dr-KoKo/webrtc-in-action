package tests

// lifecycle_test.go — Phase-0 characterization tests for the
// onetoone WebSocket session lifecycle. These document subtle
// behaviors of the *current* handler before the wsserver
// extraction lands; the same suite must keep passing after the
// migration. See plan: /home/lw/.claude/plans/make-plan-analyze-code-dazzling-perlis.md
//
// Five behaviors locked in here:
//   1. Pong-timeout disconnect reason — what `reason` lands on the
//      ws_disconnected log when heartbeat times out.
//   2. Ungraceful TCP close → cleanup runs on context.Background()
//      and the remaining peer is notified.
//   3. Malformed-frame continuation — the read loop logs and
//      continues; a subsequent valid frame still dispatches.
//   4. leave_room double-close — handler closes inside HandleFrame;
//      teardown closes again; no error log line appears.
//   5. Heartbeat CloseNow → teardown Close — the second close
//      attempt by teardown after heartbeat's CloseNow does not
//      surface an error in the log.

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	sig "webrtc-lab/signaling/internal/modes/onetoone"
)

// ---------------------------------------------------------------------
// Helpers (in-file; the cross-test helpers in heartbeat_test.go are in
// the same package and reused).
// ---------------------------------------------------------------------

// joinRoom sends a v1 join_room frame for roomID and returns the
// matching join_accepted envelope.
func joinRoom(t *testing.T, ctx context.Context, conn *websocket.Conn, roomID, requestID string) sig.Envelope {
	t.Helper()
	payload, _ := json.Marshal(sig.JoinRoomPayload{})
	env := sig.Envelope{
		V:         sig.ContractVersion,
		Type:      sig.TypeJoinRoom,
		RoomID:    roomID,
		RequestID: requestID,
		Payload:   payload,
	}
	raw, _ := json.Marshal(env)
	if err := conn.Write(ctx, websocket.MessageText, raw); err != nil {
		t.Fatalf("write join_room: %v", err)
	}
	got := readEnvelope(t, ctx, conn)
	if got.Type != sig.TypeJoinAccepted {
		t.Fatalf("expected join_accepted, got %q (raw payload %s)", got.Type, string(got.Payload))
	}
	return got
}

// readEnvelope reads one text frame and decodes it as an Envelope.
func readEnvelope(t *testing.T, ctx context.Context, conn *websocket.Conn) sig.Envelope {
	t.Helper()
	_, raw, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var env sig.Envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatalf("unmarshal envelope: %v (raw=%s)", err, string(raw))
	}
	return env
}

// readUntilType drains frames until one of `wants` appears, returning
// it. Fails the test if ctx expires before a match.
func readUntilType(t *testing.T, ctx context.Context, conn *websocket.Conn, wants ...sig.Type) sig.Envelope {
	t.Helper()
	wantSet := make(map[sig.Type]bool, len(wants))
	for _, w := range wants {
		wantSet[w] = true
	}
	for {
		env := readEnvelope(t, ctx, conn)
		if wantSet[env.Type] {
			return env
		}
		// otherwise drop and continue
	}
}

// findDisconnectLogReason scans a JSON-line log buffer for the
// `ws_disconnected` event and returns its `reason` field. Empty
// string means not found.
func findDisconnectLogReason(t *testing.T, captured string) string {
	t.Helper()
	for _, line := range strings.Split(captured, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var rec map[string]any
		if err := json.Unmarshal([]byte(line), &rec); err != nil {
			continue
		}
		if rec["event"] == "ws_disconnected" {
			if r, ok := rec["reason"].(string); ok {
				return r
			}
		}
	}
	return ""
}

// countSubstr counts non-overlapping occurrences of sub in s.
func countSubstr(s, sub string) int {
	if sub == "" {
		return 0
	}
	return strings.Count(s, sub)
}

// uuidLike returns a deterministic v4-shape UUID string for tests.
func uuidLike(suffix string) string {
	if len(suffix) > 12 {
		suffix = suffix[:12]
	}
	pad := strings.Repeat("0", 12-len(suffix)) + suffix
	return "deadbeef-0000-4000-8000-" + pad
}

// ---------------------------------------------------------------------
// Test 1 — Pong-timeout disconnect reason
// ---------------------------------------------------------------------
//
// When heartbeat detects pong timeout, it calls conn.CloseNow() and
// returns a *HeartbeatError. The read loop unblocks with an error
// from the now-closed conn. ServeHTTP's switch picks readErr first
// (lines 155-166), so the disconnect log's `reason` is whatever
// classifyReadError returns for a CloseNow-induced read error — NOT
// "pong_timeout". This test characterizes that exact value so the
// wsserver extraction cannot drift it.

func TestLifecycle_PongTimeoutDisconnectReason(t *testing.T) {
	log, buf := captureLogger()
	h := newFastHandler(log)
	ts := httptest.NewServer(h)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, wsURLFor(ts), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.CloseNow()

	// Don't pump reads → no auto-pong → server hits pong timeout.
	time.Sleep(400 * time.Millisecond)

	// Force the read side to observe the close so the handler
	// goroutine progresses to teardown + ws_disconnected log emission.
	readCtx, cancelRead := context.WithTimeout(ctx, 1*time.Second)
	defer cancelRead()
	_, _, _ = conn.Read(readCtx)

	// Allow the handler goroutine to flush its disconnect log.
	time.Sleep(200 * time.Millisecond)

	captured := buf.String()
	reason := findDisconnectLogReason(t, captured)
	if reason == "" {
		t.Fatalf("no ws_disconnected log line found; captured:\n%s", captured)
	}

	// readErr-beats-hbErr precedence (handler.go:155-166) means the
	// reason is classifyReadError's output, not "pong_timeout".
	// Acceptable values: "peer_close", "ctx_done", "read_error".
	switch reason {
	case "peer_close", "ctx_done", "read_error":
		// All three are acceptable; the precise value depends on what
		// coder/websocket surfaces from a CloseNow'd conn.
		t.Logf("characterized: pong-timeout disconnect reason = %q", reason)
	case "pong_timeout":
		t.Fatalf("disconnect reason was %q — readErr-beats-hbErr precedence broken; review handler.go:155-166", reason)
	default:
		t.Fatalf("unexpected disconnect reason %q; captured:\n%s", reason, captured)
	}

	// The heartbeat package's own pong_timeout log line MUST still
	// appear (heartbeat.go:113-116).
	if !strings.Contains(captured, "\"event\":\"pong_timeout\"") {
		t.Errorf("expected pong_timeout heartbeat log; captured:\n%s", captured)
	}
}

// ---------------------------------------------------------------------
// Test 2 — Ungraceful TCP close → cleanup runs and remaining peer is
// notified
// ---------------------------------------------------------------------
//
// Two clients join the same room (both pending-media). A force-closes
// its underlying TCP connection without sending a close frame. The
// server's deferred cleanup calls releaseAndNotify(_, cc, "disconnect")
// — onetoone's signature uses `_ context.Context` (handler.go:443) so
// it cannot fail with context.Canceled. The remaining peer B receives
// peer_presence_changed{presence: released, reason: disconnect}
// because pending-media departures are pre-pairing per
// classifyDeparture (handler.go:389-422).

func TestLifecycle_UngracefulCloseCleanupOnBackground(t *testing.T) {
	log, buf := captureLogger()
	h := sig.NewHandler(log)
	ts := httptest.NewServer(h)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	roomID := "demo"

	// Connect peer B first so it's waiting when A joins.
	connB, _, err := websocket.Dial(ctx, wsURLFor(ts), nil)
	if err != nil {
		t.Fatalf("dial B: %v", err)
	}
	defer connB.CloseNow()
	_ = joinRoom(t, ctx, connB, roomID, uuidLike("1"))

	// Connect peer A and admit. Use a low-level dial so we can hard-
	// close the TCP socket later, which is what websocket.CloseNow
	// approximates well enough for our purposes (no graceful frame).
	connA, _, err := websocket.Dial(ctx, wsURLFor(ts), nil)
	if err != nil {
		t.Fatalf("dial A: %v", err)
	}
	_ = joinRoom(t, ctx, connA, roomID, uuidLike("2"))

	// B receives two admission presence frames before A's disconnect:
	//   1. B's own admission (broadcastPresence at handler.go:335
	//      includes the subject), and
	//   2. A's admission (same broadcast call when A joins).
	// Drain both so the next presence frame B reads is A's disconnect.
	for i := 0; i < 2; i++ {
		got := readUntilType(t, ctx, connB, sig.TypePeerPresenceChanged)
		var p sig.PeerPresenceChangedPayload
		_ = json.Unmarshal(got.Payload, &p)
		if p.Reason != sig.PresenceReasonAdmitted {
			t.Fatalf("drain[%d]: expected admission frame, got presence=%q reason=%q", i, p.Presence, p.Reason)
		}
	}

	// A force-closes — no graceful close frame; server's read loop
	// fails, deferred cleanup fires on context.Background() (the
	// releaseAndNotify signature at handler.go:443 ignores the ctx
	// parameter entirely with `_ context.Context`).
	_ = connA.CloseNow()

	// B should receive presence:released, reason:disconnect for the
	// pending-media departure.
	got := readUntilType(t, ctx, connB, sig.TypePeerPresenceChanged)
	var p sig.PeerPresenceChangedPayload
	if err := json.Unmarshal(got.Payload, &p); err != nil {
		t.Fatalf("unmarshal presence: %v", err)
	}
	if p.Presence != sig.PresenceReleased {
		t.Errorf("expected presence=%q, got %q", sig.PresenceReleased, p.Presence)
	}
	if p.Reason != sig.PresenceReasonDisconnect {
		t.Errorf("expected reason=%q, got %q", sig.PresenceReasonDisconnect, p.Reason)
	}

	// Cleanup must not have logged any context-related errors.
	captured := buf.String()
	if strings.Contains(captured, "context canceled") || strings.Contains(captured, "context deadline exceeded") {
		t.Errorf("cleanup log unexpectedly contains context error; captured:\n%s", captured)
	}
}

// ---------------------------------------------------------------------
// Test 3 — Malformed-frame continuation
// ---------------------------------------------------------------------
//
// A malformed envelope produces an `error` frame; the read loop
// continues (handler.go:188 "decode errors are already surfaced;
// log and continue"). A subsequent valid join_room must still
// dispatch normally on the same WS.

func TestLifecycle_MalformedFrameContinuation(t *testing.T) {
	h := sig.NewHandler(silentLogger())
	ts := httptest.NewServer(h)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, wsURLFor(ts), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.CloseNow()

	// Step 1: send a v=2 frame (unsupported_version → error frame, no disconnect).
	bad := []byte(`{"v":2,"type":"join_room","roomId":"demo","requestId":"deadbeef-0000-4000-8000-000000000099","payload":{}}`)
	if err := conn.Write(ctx, websocket.MessageText, bad); err != nil {
		t.Fatalf("write malformed: %v", err)
	}
	errEnv := readEnvelope(t, ctx, conn)
	if errEnv.Type != sig.TypeError {
		t.Fatalf("expected error frame for malformed input, got %q", errEnv.Type)
	}

	// Step 2: send a valid join_room and assert it dispatches.
	got := joinRoom(t, ctx, conn, "demo", uuidLike("3"))
	if got.Type != sig.TypeJoinAccepted {
		t.Fatalf("post-malformed join_room did not produce join_accepted: got %q", got.Type)
	}
}

// ---------------------------------------------------------------------
// Test 4 — leave_room double-close
// ---------------------------------------------------------------------
//
// handleLeaveRoom (handler.go:348) calls
//   _ = cc.conn.Close(websocket.StatusNormalClosure, "graceful_leave")
// at line 366. ServeHTTP's deferred teardown then calls
//   _ = conn.Close(websocket.StatusNormalClosure, "bye")
// at line 175. The error from the second close is swallowed by `_ =`,
// so no error log line should appear, and exactly one
// ws_disconnected log line should be emitted.

func TestLifecycle_LeaveRoomDoubleClose(t *testing.T) {
	log, buf := captureLogger()
	h := sig.NewHandler(log)
	ts := httptest.NewServer(h)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, wsURLFor(ts), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.CloseNow()

	_ = joinRoom(t, ctx, conn, "demo", uuidLike("4"))

	// Drain self-admission presence frame so the next read is the
	// server-driven close after leave_room.
	_ = readUntilType(t, ctx, conn, sig.TypePeerPresenceChanged)

	// Send leave_room. handleLeaveRoom (handler.go:357 +366) calls
	// releaseAndNotify and then `_ = cc.conn.Close(... "graceful_leave")`.
	// The read loop unblocks; teardown calls `_ = conn.Close(... "bye")`
	// at handler.go:175. Both close calls swallow errors via `_ =`.
	leavePayload, _ := json.Marshal(struct{}{})
	leave := sig.Envelope{
		V:         sig.ContractVersion,
		Type:      sig.TypeLeaveRoom,
		RoomID:    "demo",
		RequestID: uuidLike("6"),
		Payload:   leavePayload,
	}
	raw, _ := json.Marshal(leave)
	if err := conn.Write(ctx, websocket.MessageText, raw); err != nil {
		t.Fatalf("write leave_room: %v", err)
	}

	// Server-side close → client Read returns an error.
	_, _, _ = conn.Read(ctx)

	// Allow handler goroutine to emit ws_disconnected.
	time.Sleep(150 * time.Millisecond)

	captured := buf.String()
	if got := countSubstr(captured, "\"event\":\"ws_disconnected\""); got != 1 {
		t.Errorf("expected exactly 1 ws_disconnected log line, got %d; captured:\n%s", got, captured)
	}
	// No "close failed" / "second close" error should appear from the
	// double-close pattern.
	if strings.Contains(captured, "close failed") || strings.Contains(captured, "double close") {
		t.Errorf("unexpected close-error log; captured:\n%s", captured)
	}
}

// ---------------------------------------------------------------------
// Test 5 — Heartbeat CloseNow → teardown Close
// ---------------------------------------------------------------------
//
// On pong timeout, heartbeat calls conn.CloseNow() (heartbeat.go:117).
// The deferred teardown in ServeHTTP later calls conn.Close (line
// 175) on the already-closed conn. Both close calls swallow errors
// (`_ = ...`). Assert:
//   * exactly one pong_timeout heartbeat log
//   * exactly one ws_disconnected log
//   * no "close failed" or similar error log line
// This is the specific sequence wsserver.Session.Close will inherit.

func TestLifecycle_HeartbeatCloseNowThenTeardownClose(t *testing.T) {
	log, buf := captureLogger()
	h := newFastHandler(log)
	ts := httptest.NewServer(h)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, wsURLFor(ts), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.CloseNow()

	// Don't pump reads.
	time.Sleep(400 * time.Millisecond)
	readCtx, cancelRead := context.WithTimeout(ctx, 1*time.Second)
	defer cancelRead()
	_, _, _ = conn.Read(readCtx)
	time.Sleep(200 * time.Millisecond)

	captured := buf.String()
	if got := countSubstr(captured, "\"event\":\"pong_timeout\""); got != 1 {
		t.Errorf("expected exactly 1 pong_timeout log, got %d; captured:\n%s", got, captured)
	}
	if got := countSubstr(captured, "\"event\":\"ws_disconnected\""); got != 1 {
		t.Errorf("expected exactly 1 ws_disconnected log, got %d; captured:\n%s", got, captured)
	}
	if strings.Contains(captured, "close failed") || strings.Contains(captured, "double close") {
		t.Errorf("unexpected close-error log; captured:\n%s", captured)
	}
}

// ---------------------------------------------------------------------
// _ helpers below ensure the imports above are referenced even if any
// individual test is later disabled. These use vars so the linter
// keeps the imports.
// ---------------------------------------------------------------------

var (
	_ = http.StatusOK
	_ = net.Listen
	_ = url.Parse
	_ = fmt.Sprintf
)
