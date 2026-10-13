package mesh_test

// lifecycle_test.go — Phase-0 characterization tests for the mesh
// WebSocket session lifecycle. Mirror of
// signaling/tests/modes/onetoone/lifecycle_test.go for the v2
// contract. Locks in the same five behaviors before the wsserver
// extraction lands. See plan: /home/lw/.claude/plans/make-plan-analyze-code-dazzling-perlis.md

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"webrtc-lab/signaling/internal/modes/mesh"

	protocol "webrtc-lab/signaling/internal/modes/mesh/protocol"
)

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

// makeFastHandler returns a mesh.Handler with sub-second heartbeat
// for fast pong-timeout tests. Heartbeat timing is injected via
// fastModeConfig() at construction.
func makeFastHandler(t *testing.T, useCapture bool) (*mesh.Handler, *syncBuffer) {
	t.Helper()
	var (
		h   *mesh.Handler
		buf *syncBuffer
	)
	if useCapture {
		log, b := captureLogger()
		h = mesh.NewHandler(log, fastModeConfig())
		buf = b
	} else {
		h = mesh.NewHandler(silentLogger(), fastModeConfig())
	}
	return h, buf
}

func meshJoinRoom(t *testing.T, ctx context.Context, conn *websocket.Conn, roomID, requestID string) protocol.Envelope {
	t.Helper()
	env := protocol.Envelope{
		V:         protocol.ContractVersion,
		Type:      protocol.TypeJoinRoom,
		RoomID:    roomID,
		RequestID: requestID,
		Payload:   json.RawMessage(`{}`),
	}
	raw, _ := json.Marshal(env)
	if err := conn.Write(ctx, websocket.MessageText, raw); err != nil {
		t.Fatalf("write join_room: %v", err)
	}
	got := readMeshUntilType(t, ctx, conn, protocol.TypeJoinAccepted, protocol.TypeJoinRejected)
	if got.Type != protocol.TypeJoinAccepted {
		t.Fatalf("expected join_accepted, got %q", got.Type)
	}
	return got
}

func readMeshEnvelope(t *testing.T, ctx context.Context, conn *websocket.Conn) protocol.Envelope {
	t.Helper()
	_, raw, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var env protocol.Envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatalf("unmarshal envelope: %v (raw=%s)", err, string(raw))
	}
	return env
}

func readMeshUntilType(t *testing.T, ctx context.Context, conn *websocket.Conn, wants ...protocol.MessageType) protocol.Envelope {
	t.Helper()
	wantSet := make(map[protocol.MessageType]bool, len(wants))
	for _, w := range wants {
		wantSet[w] = true
	}
	for {
		env := readMeshEnvelope(t, ctx, conn)
		if wantSet[env.Type] {
			return env
		}
	}
}

func meshFindDisconnectReason(captured string) string {
	for _, line := range strings.Split(captured, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var rec map[string]any
		if err := json.Unmarshal([]byte(line), &rec); err != nil {
			continue
		}
		if rec["event"] == "mesh_ws_disconnected" {
			if r, ok := rec["reason"].(string); ok {
				return r
			}
		}
	}
	return ""
}

func meshUUIDLike(suffix string) string {
	if len(suffix) > 12 {
		suffix = suffix[:12]
	}
	pad := strings.Repeat("0", 12-len(suffix)) + suffix
	return "deadbeef-0000-4000-8000-" + pad
}

func meshCountSubstr(s, sub string) int {
	if sub == "" {
		return 0
	}
	return strings.Count(s, sub)
}

// ---------------------------------------------------------------------
// Test 1 — Pong-timeout disconnect reason
// ---------------------------------------------------------------------
//
// Same shape as onetoone test 1: the disconnect log's `reason` is
// classifyReadError's output (read_error / peer_close / ctx_done),
// NOT "pong_timeout", because of readErr-beats-hbErr precedence at
// mesh/handler.go:118-129. Heartbeat's own
// `mesh_pong_timeout` log line still appears separately.

func TestLifecycle_Mesh_PongTimeoutDisconnectReason(t *testing.T) {
	h, buf := makeFastHandler(t, true)
	ts := httptest.NewServer(h)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, meshURLFor(ts), nil)
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
	reason := meshFindDisconnectReason(captured)
	if reason == "" {
		t.Fatalf("no mesh_ws_disconnected log line found; captured:\n%s", captured)
	}

	switch reason {
	case "peer_close", "ctx_done", "read_error":
		t.Logf("characterized: mesh pong-timeout disconnect reason = %q", reason)
	case "pong_timeout":
		t.Fatalf("disconnect reason was %q — readErr-beats-hbErr broken; review mesh/handler.go:118-129", reason)
	default:
		t.Fatalf("unexpected disconnect reason %q; captured:\n%s", reason, captured)
	}

	if !strings.Contains(captured, "\"event\":\"mesh_pong_timeout\"") {
		t.Errorf("expected mesh_pong_timeout heartbeat log; captured:\n%s", captured)
	}
}

// ---------------------------------------------------------------------
// Test 2 — Ungraceful TCP close → cleanup runs and remaining peer is
// notified
// ---------------------------------------------------------------------
//
// Two clients join the same room. A force-closes (no graceful frame).
// Server cleanup at mesh/handler.go:134-136 runs releaseAndNotify
// which broadcasts mesh_roster_update{presence: left,
// reason: disconnect} to remaining participants. SendJSON inside
// releaseAndNotify uses connCtx.baseCtx (mesh/handler.go:160-162)
// which is the request-scope ctx — not yet cancelled at broadcast
// time on the surviving connection.

func TestLifecycle_Mesh_UngracefulCloseCleanupOnBaseCtx(t *testing.T) {
	log, buf := captureLogger()
	h := mesh.NewHandler(log, defaultModeConfig())
	ts := httptest.NewServer(h)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	roomID := "demo"

	connB, _, err := websocket.Dial(ctx, meshURLFor(ts), nil)
	if err != nil {
		t.Fatalf("dial B: %v", err)
	}
	defer connB.CloseNow()
	_ = meshJoinRoom(t, ctx, connB, roomID, meshUUIDLike("1"))
	// After join_accepted, server immediately sends mesh_roster_snapshot
	// (mesh/handler.go:341), then mesh_roster_update{B, joined,
	// admitted} (mesh/handler.go:354 broadcasts to all). Drain both.
	_ = readMeshUntilType(t, ctx, connB, protocol.TypeMeshRosterSnapshot)
	gotSelf := readMeshUntilType(t, ctx, connB, protocol.TypeMeshRosterUpdate)
	var pSelf protocol.MeshRosterUpdatePayload
	_ = json.Unmarshal(gotSelf.Payload, &pSelf)
	if pSelf.Reason != protocol.RosterReasonAdmitted {
		t.Fatalf("expected B-self admission update, got reason=%q", pSelf.Reason)
	}

	connA, _, err := websocket.Dial(ctx, meshURLFor(ts), nil)
	if err != nil {
		t.Fatalf("dial A: %v", err)
	}
	_ = meshJoinRoom(t, ctx, connA, roomID, meshUUIDLike("2"))
	// B receives mesh_roster_update for A's admission.
	gotA := readMeshUntilType(t, ctx, connB, protocol.TypeMeshRosterUpdate)
	var pA protocol.MeshRosterUpdatePayload
	_ = json.Unmarshal(gotA.Payload, &pA)
	if pA.Reason != protocol.RosterReasonAdmitted {
		t.Fatalf("expected A admission update, got reason=%q", pA.Reason)
	}

	// A force-closes — server cleanup fires releaseAndNotify which
	// broadcasts mesh_roster_update{A, left, disconnect} to remaining.
	_ = connA.CloseNow()

	got := readMeshUntilType(t, ctx, connB, protocol.TypeMeshRosterUpdate)
	var p protocol.MeshRosterUpdatePayload
	if err := json.Unmarshal(got.Payload, &p); err != nil {
		t.Fatalf("unmarshal roster update: %v", err)
	}
	if p.Presence != protocol.PresenceLeft {
		t.Errorf("expected presence=%q, got %q", protocol.PresenceLeft, p.Presence)
	}
	if p.Reason != protocol.RosterReasonDisconnect {
		t.Errorf("expected reason=%q, got %q", protocol.RosterReasonDisconnect, p.Reason)
	}

	captured := buf.String()
	if strings.Contains(captured, "context canceled") || strings.Contains(captured, "context deadline exceeded") {
		t.Errorf("cleanup log unexpectedly contains context error; captured:\n%s", captured)
	}
}

// ---------------------------------------------------------------------
// Test 3 — Malformed-frame continuation
// ---------------------------------------------------------------------
//
// A v=1 frame yields an `error` envelope (unsupported_version). The
// read loop continues per mesh/handler.go:202-226. A subsequent
// valid v=2 join_room must dispatch to join_accepted on the same WS.

func TestLifecycle_Mesh_MalformedFrameContinuation(t *testing.T) {
	h := mesh.NewHandler(silentLogger(), defaultModeConfig())
	ts := httptest.NewServer(h)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, meshURLFor(ts), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.CloseNow()

	bad := []byte(`{"v":1,"type":"join_room","roomId":"demo","requestId":"deadbeef-0000-4000-8000-000000000099","payload":{}}`)
	if err := conn.Write(ctx, websocket.MessageText, bad); err != nil {
		t.Fatalf("write malformed: %v", err)
	}
	errEnv := readMeshEnvelope(t, ctx, conn)
	if errEnv.Type != protocol.TypeError {
		t.Fatalf("expected error frame for malformed input, got %q", errEnv.Type)
	}

	got := meshJoinRoom(t, ctx, conn, "demo", meshUUIDLike("3"))
	if got.Type != protocol.TypeJoinAccepted {
		t.Fatalf("post-malformed join_room did not produce join_accepted: got %q", got.Type)
	}
}

// ---------------------------------------------------------------------
// Test 4 — leave_room double-close
// ---------------------------------------------------------------------
//
// handleLeaveRoom (mesh/handler.go:367) calls
//   _ = cc.conn.Close(websocket.StatusNormalClosure, "graceful_leave")
// at line 378. Teardown then calls
//   _ = conn.Close(websocket.StatusNormalClosure, "bye")
// at line 138. Both swallow errors via `_ =`. Assert exactly one
// mesh_ws_disconnected log line and no error log.

func TestLifecycle_Mesh_LeaveRoomDoubleClose(t *testing.T) {
	log, buf := captureLogger()
	h := mesh.NewHandler(log, defaultModeConfig())
	ts := httptest.NewServer(h)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, meshURLFor(ts), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.CloseNow()

	_ = meshJoinRoom(t, ctx, conn, "demo", meshUUIDLike("4"))
	// Drain snapshot + own admission roster_update.
	_ = readMeshUntilType(t, ctx, conn, protocol.TypeMeshRosterSnapshot)
	_ = readMeshUntilType(t, ctx, conn, protocol.TypeMeshRosterUpdate)

	leave := protocol.Envelope{
		V:         protocol.ContractVersion,
		Type:      protocol.TypeLeaveRoom,
		RoomID:    "demo",
		RequestID: meshUUIDLike("6"),
		Payload:   json.RawMessage(`{}`),
	}
	raw, _ := json.Marshal(leave)
	if err := conn.Write(ctx, websocket.MessageText, raw); err != nil {
		t.Fatalf("write leave_room: %v", err)
	}
	_, _, _ = conn.Read(ctx)
	time.Sleep(150 * time.Millisecond)

	captured := buf.String()
	if got := meshCountSubstr(captured, "\"event\":\"mesh_ws_disconnected\""); got != 1 {
		t.Errorf("expected exactly 1 mesh_ws_disconnected log line, got %d; captured:\n%s", got, captured)
	}
	if strings.Contains(captured, "close failed") || strings.Contains(captured, "double close") {
		t.Errorf("unexpected close-error log; captured:\n%s", captured)
	}
}

// ---------------------------------------------------------------------
// Test 5 — Heartbeat CloseNow → teardown Close
// ---------------------------------------------------------------------
//
// On pong timeout, heartbeat calls conn.CloseNow()
// (internal/shared/heartbeat/heartbeat.go:117). Teardown calls
// conn.Close at mesh/handler.go:138 on the already-closed conn.
// Both swallow errors. Assert exactly one mesh_pong_timeout log
// line, exactly one mesh_ws_disconnected log line, no error log.

func TestLifecycle_Mesh_HeartbeatCloseNowThenTeardownClose(t *testing.T) {
	h, buf := makeFastHandler(t, true)
	ts := httptest.NewServer(h)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, meshURLFor(ts), nil)
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
	if got := meshCountSubstr(captured, "\"event\":\"mesh_pong_timeout\""); got != 1 {
		t.Errorf("expected exactly 1 mesh_pong_timeout log, got %d; captured:\n%s", got, captured)
	}
	if got := meshCountSubstr(captured, "\"event\":\"mesh_ws_disconnected\""); got != 1 {
		t.Errorf("expected exactly 1 mesh_ws_disconnected log, got %d; captured:\n%s", got, captured)
	}
	if strings.Contains(captured, "close failed") || strings.Contains(captured, "double close") {
		t.Errorf("unexpected close-error log; captured:\n%s", captured)
	}
}
