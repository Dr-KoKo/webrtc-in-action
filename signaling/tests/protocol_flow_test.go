package tests

// Phase 3 WebSocket-level protocol-flow tests. These drive the /ws
// handler end-to-end with real in-process WebSocket clients and
// assert on the wire-level message sequence.
//
// Phase 3 is scoped to admission flow only: join_room,
// join_accepted, join_rejected, peer_presence_changed, leave_room,
// and the *pre-pairing* branch of the graceful-leave classification
// from contract §3.14 / data-model §C.6. In-call departure
// (TestInCallLeaveEmitsPeerLeft) requires role assignment + offer/
// answer relay and belongs to Phase 4 (T034B / T086).

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"

	sig "webrtc-lab/signaling/internal/signaling"
)

// newRequestID returns a fresh UUID suitable for a contract-§3.1
// join_room requestId. Each protocol-flow test calls this directly
// so the IDs stay unique per call and we don't leak state across
// tests.
func newRequestID() string { return uuid.NewString() }

// ---------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------

// flowServer spins up a /ws handler with a fresh RoomManager and
// returns the test server plus a cleanup func.
func flowServer(t *testing.T) *httptest.Server {
	t.Helper()
	log, buf := captureLogger()
	t.Cleanup(func() {
		if t.Failed() {
			t.Logf("server log:\n%s", buf.String())
		}
	})
	h := sig.NewHandler(log)
	// Slow the heartbeat down so tests aren't racing a 50ms ping. Real
	// heartbeat tests live in heartbeat_test.go.
	h.Heartbeat = sig.HeartbeatConfig{
		PingInterval: 10 * time.Second,
		PongTimeout:  10 * time.Second,
	}
	ts := httptest.NewServer(h)
	t.Cleanup(func() { ts.Close() })
	return ts
}

type testClient struct {
	t    *testing.T
	conn *websocket.Conn
	ctx  context.Context
}

func dialClient(t *testing.T, ts *httptest.Server) *testClient {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(cancel)
	conn, _, err := websocket.Dial(ctx, wsURLFor(ts), nil)
	if err != nil {
		t.Fatalf("dial failed: %v", err)
	}
	t.Cleanup(func() { _ = conn.CloseNow() })
	return &testClient{t: t, conn: conn, ctx: ctx}
}

// send writes a JSON envelope to the server.
func (c *testClient) send(v any) {
	c.t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		c.t.Fatalf("marshal: %v", err)
	}
	if err := c.conn.Write(c.ctx, websocket.MessageText, raw); err != nil {
		c.t.Fatalf("write: %v", err)
	}
}

// expect reads one frame with a 2 s timeout and asserts it parses to
// the expected envelope type. Returns the parsed Envelope + raw
// payload bytes for the caller to decode.
func (c *testClient) expect(wantType sig.Type) (sig.Envelope, json.RawMessage) {
	c.t.Helper()
	rctx, cancel := context.WithTimeout(c.ctx, 2*time.Second)
	defer cancel()
	_, raw, err := c.conn.Read(rctx)
	if err != nil {
		c.t.Fatalf("read: %v", err)
	}
	var env sig.Envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		c.t.Fatalf("unmarshal envelope: %v (raw=%s)", err, string(raw))
	}
	if env.Type != wantType {
		c.t.Fatalf("got type %q (raw=%s), want %q", env.Type, string(raw), wantType)
	}
	return env, env.Payload
}

// expectNone asserts no message arrives within the given window.
//
// Implementation note: we deliberately do NOT cancel the Read's
// context after the window, because coder/websocket closes the
// underlying connection when a Read ctx is cancelled (a known
// gotcha — see the coder/websocket Read doc). Instead we race the
// Read against a timer on a goroutine. If the timer wins, the Read
// goroutine is left blocked; test cleanup closes the WS and the
// goroutine exits. Callers MUST treat expectNone as a terminal
// assertion for that client.
func (c *testClient) expectNone(window time.Duration) {
	c.t.Helper()
	got := make(chan []byte, 1)
	errCh := make(chan error, 1)
	go func() {
		_, raw, err := c.conn.Read(c.ctx)
		if err != nil {
			errCh <- err
			return
		}
		got <- raw
	}()
	select {
	case <-time.After(window):
		// success — no frame in the window.
	case raw := <-got:
		c.t.Fatalf("expected no frame within %v, got: %s", window, string(raw))
	case err := <-errCh:
		c.t.Fatalf("expected no frame within %v, got read error: %v", window, err)
	}
}

func joinRoomMsg(roomID, requestID string) any {
	return map[string]any{
		"v":         1,
		"type":      "join_room",
		"roomId":    roomID,
		"requestId": requestID,
		"payload":   map[string]any{},
	}
}

func leaveRoomMsg(roomID string) any {
	return map[string]any{
		"v":       1,
		"type":    "leave_room",
		"roomId":  roomID,
		"payload": map[string]any{},
	}
}

func parsePayload[T any](t *testing.T, raw json.RawMessage) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("payload parse: %v (raw=%s)", err, string(raw))
	}
	return v
}

// joinAndAck admits a client to the given room and returns its
// server-assigned peerId. It also drains the self-targeted
// peer_presence_changed that follows join_accepted, since almost
// every test wants a "clean slate" after the initial admission.
func (c *testClient) joinAndAck(roomID, requestID string) string {
	c.t.Helper()
	c.send(joinRoomMsg(roomID, requestID))
	_, raw := c.expect(sig.TypeJoinAccepted)
	accepted := parsePayload[sig.JoinAcceptedPayload](c.t, raw)

	// Per §3.4, peer_presence_changed is broadcast to every reserved
	// slot (including the subject). The newly-admitted peer therefore
	// receives a self-targeted pending-media / admitted event right
	// after join_accepted.
	_, rawP := c.expect(sig.TypePeerPresenceChanged)
	selfEvent := parsePayload[sig.PeerPresenceChangedPayload](c.t, rawP)
	if selfEvent.SubjectPeerID != accepted.PeerID {
		c.t.Fatalf("post-admit self-presence: subject=%s, want peerId=%s",
			selfEvent.SubjectPeerID, accepted.PeerID)
	}
	return accepted.PeerID
}

// ---------------------------------------------------------------------
// Admission flow
// ---------------------------------------------------------------------

func TestTwoClientsJoinAndSeePresence(t *testing.T) {
	ts := flowServer(t)

	a := dialClient(t, ts)
	peerA := a.joinAndAck("demo", newRequestID())

	b := dialClient(t, ts)
	b.send(joinRoomMsg("demo", newRequestID()))

	// B receives join_accepted with remotePeer=A.
	_, raw := b.expect(sig.TypeJoinAccepted)
	acceptedB := parsePayload[sig.JoinAcceptedPayload](t, raw)
	if acceptedB.AdmissionOrder != 2 {
		t.Fatalf("B admissionOrder = %d, want 2", acceptedB.AdmissionOrder)
	}
	if acceptedB.RemotePeer == nil || acceptedB.RemotePeer.PeerID != peerA {
		t.Fatalf("B join_accepted.remotePeer = %+v, want {peerId=%s}",
			acceptedB.RemotePeer, peerA)
	}

	// Both A and B receive peer_presence_changed(subject=B).
	_, rawA := a.expect(sig.TypePeerPresenceChanged)
	presA := parsePayload[sig.PeerPresenceChangedPayload](t, rawA)
	if presA.SubjectPeerID != acceptedB.PeerID {
		t.Fatalf("A presence subject=%s, want %s", presA.SubjectPeerID, acceptedB.PeerID)
	}
	if presA.Presence != sig.PresencePendingMedia || presA.Reason != sig.PresenceReasonAdmitted {
		t.Fatalf("A presence = {presence:%s reason:%s}, want {pending-media, admitted}",
			presA.Presence, presA.Reason)
	}

	_, rawB := b.expect(sig.TypePeerPresenceChanged)
	presB := parsePayload[sig.PeerPresenceChangedPayload](t, rawB)
	if presB.SubjectPeerID != acceptedB.PeerID {
		t.Fatalf("B presence subject=%s, want self=%s",
			presB.SubjectPeerID, acceptedB.PeerID)
	}
}

func TestThirdJoinRejectedRoomFull(t *testing.T) {
	ts := flowServer(t)

	a := dialClient(t, ts)
	a.joinAndAck("demo", newRequestID())

	b := dialClient(t, ts)
	b.joinAndAck("demo", newRequestID())

	// Drain B's join-triggered presence event from A's queue.
	_, _ = a.expect(sig.TypePeerPresenceChanged)

	c := dialClient(t, ts)
	c.send(joinRoomMsg("demo", newRequestID()))

	_, raw := c.expect(sig.TypeJoinRejected)
	rej := parsePayload[sig.JoinRejectedPayload](t, raw)
	if rej.Result != sig.JoinRejectedRoomFull {
		t.Fatalf("third join result=%q, want join_rejected_room_full", rej.Result)
	}
	if rej.Reason != sig.ReasonRoomFull {
		t.Fatalf("third join reason=%q, want room_full", rej.Reason)
	}

	// Neither A nor B should see any event as a result of C's
	// rejected join attempt — no slot was reserved.
	a.expectNone(200 * time.Millisecond)
	b.expectNone(200 * time.Millisecond)
}

func TestInvalidRoomIDRejected(t *testing.T) {
	ts := flowServer(t)

	c := dialClient(t, ts)
	// Send a join_room with an invalid room ID. Bypass our helper
	// because we want the raw envelope to go through even though the
	// roomId fails the regex. The requestId must still be a valid UUID
	// — envelope-level validation rejects malformed UUIDs before the
	// handler sees the roomId.
	c.send(map[string]any{
		"v":         1,
		"type":      "join_room",
		"roomId":    "bad room!",
		"requestId": newRequestID(),
		"payload":   map[string]any{},
	})

	_, raw := c.expect(sig.TypeJoinRejected)
	rej := parsePayload[sig.JoinRejectedPayload](t, raw)
	if rej.Result != sig.JoinRejectedInvalidRoom {
		t.Fatalf("result=%q, want join_rejected_invalid_room", rej.Result)
	}
	if rej.Reason != sig.ReasonInvalidRoomID {
		t.Fatalf("reason=%q, want invalid_room_id", rej.Reason)
	}
}

// ---------------------------------------------------------------------
// Pre-pairing leave / disconnect — the classification contract
// ---------------------------------------------------------------------
//
// Until Phase 4 wires media_ready, every Phase 3 participant sits in
// callPhase=idle + mediaReadiness=pending-media. Departures in this
// state are by definition pre-pairing, so the server MUST emit
// peer_presence_changed(presence="released") and MUST NOT emit
// peer_left (§3.12 note, §C.6 step 5).

func TestGracefulLeavePrePairingNoPeerLeft(t *testing.T) {
	ts := flowServer(t)

	a := dialClient(t, ts)
	a.joinAndAck("demo", newRequestID())

	b := dialClient(t, ts)
	b.joinAndAck("demo", newRequestID())
	// Drain B's admission event from A's queue.
	_, _ = a.expect(sig.TypePeerPresenceChanged)

	b.send(leaveRoomMsg("demo"))

	// A should observe peer_presence_changed(presence=released,
	// reason=graceful_leave). It MUST NOT receive peer_left, because
	// B never reached callPhase ∈ {role-assigned, negotiating,
	// connected}.
	_, raw := a.expect(sig.TypePeerPresenceChanged)
	pres := parsePayload[sig.PeerPresenceChangedPayload](t, raw)
	if pres.Presence != sig.PresenceReleased {
		t.Fatalf("presence=%q, want released", pres.Presence)
	}
	if pres.Reason != sig.PresenceReasonGracefulLeave {
		t.Fatalf("reason=%q, want graceful_leave", pres.Reason)
	}
	a.expectNone(200 * time.Millisecond)
}

// TestPendingMediaLeaveDoesNotEmitPeerLeft is a narrower twin of the
// test above — it asserts the same invariant from the perspective of
// an explicitly pending-media participant leaving. In Phase 3 the two
// tests are identical, but keeping the name preserves the semantic
// distinction once Phase 4 introduces `media_ready`: here the subject
// is KNOWN to be pending-media, not merely defaulting to it.
func TestPendingMediaLeaveDoesNotEmitPeerLeft(t *testing.T) {
	ts := flowServer(t)

	a := dialClient(t, ts)
	a.joinAndAck("demo", newRequestID())

	b := dialClient(t, ts)
	b.joinAndAck("demo", newRequestID())
	_, _ = a.expect(sig.TypePeerPresenceChanged)

	b.send(leaveRoomMsg("demo"))

	_, raw := a.expect(sig.TypePeerPresenceChanged)
	pres := parsePayload[sig.PeerPresenceChangedPayload](t, raw)
	if pres.Presence == sig.PresenceLeft {
		t.Fatalf("pending-media leave must not produce presence=left")
	}
	a.expectNone(200 * time.Millisecond)
}

func TestPendingMediaDisconnectDoesNotEmitPeerLeft(t *testing.T) {
	ts := flowServer(t)

	a := dialClient(t, ts)
	a.joinAndAck("demo", newRequestID())

	b := dialClient(t, ts)
	b.joinAndAck("demo", newRequestID())
	_, _ = a.expect(sig.TypePeerPresenceChanged)

	// Ungraceful close: abort B's WS without sending leave_room.
	_ = b.conn.Close(websocket.StatusAbnormalClosure, "test disconnect")

	_, raw := a.expect(sig.TypePeerPresenceChanged)
	pres := parsePayload[sig.PeerPresenceChangedPayload](t, raw)
	if pres.Presence != sig.PresenceReleased {
		t.Fatalf("presence=%q, want released (pre-pairing disconnect)", pres.Presence)
	}
	if pres.Reason != sig.PresenceReasonDisconnect {
		t.Fatalf("reason=%q, want disconnect", pres.Reason)
	}

	// A MUST NOT receive a peer_left for a disconnect that never
	// reached an in-call phase.
	a.expectNone(200 * time.Millisecond)
}

// ---------------------------------------------------------------------
// Regression tests for F1–F4
// ---------------------------------------------------------------------

// F2 regression — contract §3.14 step 5 requires the server to close
// the sender's WS on leave_room. We verify both halves:
//   1. A (remaining) sees a peer_presence_changed(released,
//      graceful_leave).
//   2. B's next Read reports a close status (not a generic read
//      error, not context cancellation).
// Asserting on the readable side is the robust signal; "next Write
// fails" would race the close handshake.
func TestLeaveRoomClosesWSAndNotifiesPeer(t *testing.T) {
	ts := flowServer(t)

	a := dialClient(t, ts)
	a.joinAndAck("demo", newRequestID())

	b := dialClient(t, ts)
	b.joinAndAck("demo", newRequestID())
	_, _ = a.expect(sig.TypePeerPresenceChanged) // drain B's admit event on A

	b.send(leaveRoomMsg("demo"))

	// (1) A sees the presence event.
	_, raw := a.expect(sig.TypePeerPresenceChanged)
	pres := parsePayload[sig.PeerPresenceChangedPayload](t, raw)
	if pres.Presence != sig.PresenceReleased {
		t.Fatalf("A presence=%q, want released", pres.Presence)
	}
	if pres.Reason != sig.PresenceReasonGracefulLeave {
		t.Fatalf("A reason=%q, want graceful_leave", pres.Reason)
	}

	// (2) B's next Read observes the server-initiated close.
	readCtx, cancel := context.WithTimeout(b.ctx, 2*time.Second)
	defer cancel()
	_, _, err := b.conn.Read(readCtx)
	if err == nil {
		t.Fatalf("expected Read to fail after server-initiated close")
	}
	// websocket.CloseStatus returns -1 when err is not a close error.
	// A valid close status (>= 1000) means the server properly closed
	// the connection; anything else is a timeout or generic read error
	// and indicates the WS was NOT closed.
	status := websocket.CloseStatus(err)
	if status == -1 {
		t.Fatalf("expected server close status; got read error %v (CloseStatus=-1)", err)
	}
}

// F3 regression — envelope-level validation rejects non-UUID
// requestId on join_room with `error{code:"malformed"}`. The slot
// must not be reserved.
func TestJoinRoomRejectsNonUUIDRequestId(t *testing.T) {
	ts := flowServer(t)

	c := dialClient(t, ts)
	c.send(map[string]any{
		"v":         1,
		"type":      "join_room",
		"roomId":    "demo",
		"requestId": "not-a-uuid",
		"payload":   map[string]any{},
	})

	env, raw := c.expect(sig.TypeError)
	payload := parsePayload[sig.ErrorPayload](t, raw)
	if payload.Code != sig.CodeMalformed {
		t.Fatalf("error.code=%q want malformed", payload.Code)
	}
	_ = env
}
