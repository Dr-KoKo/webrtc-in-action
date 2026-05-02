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
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"

	sig "webrtc-lab/signaling/internal/modes/onetoone"
	proto "webrtc-lab/signaling/internal/modes/onetoone/protocol"
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
func (c *testClient) expect(wantType proto.Type) (proto.Envelope, json.RawMessage) {
	c.t.Helper()
	rctx, cancel := context.WithTimeout(c.ctx, 2*time.Second)
	defer cancel()
	_, raw, err := c.conn.Read(rctx)
	if err != nil {
		c.t.Fatalf("read: %v", err)
	}
	var env proto.Envelope
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
	_, raw := c.expect(proto.TypeJoinAccepted)
	accepted := parsePayload[proto.JoinAcceptedPayload](c.t, raw)

	// Per §3.4, peer_presence_changed is broadcast to every reserved
	// slot (including the subject). The newly-admitted peer therefore
	// receives a self-targeted pending-media / admitted event right
	// after join_accepted.
	_, rawP := c.expect(proto.TypePeerPresenceChanged)
	selfEvent := parsePayload[proto.PeerPresenceChangedPayload](c.t, rawP)
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
	_, raw := b.expect(proto.TypeJoinAccepted)
	acceptedB := parsePayload[proto.JoinAcceptedPayload](t, raw)
	if acceptedB.AdmissionOrder != 2 {
		t.Fatalf("B admissionOrder = %d, want 2", acceptedB.AdmissionOrder)
	}
	if acceptedB.RemotePeer == nil || acceptedB.RemotePeer.PeerID != peerA {
		t.Fatalf("B join_accepted.remotePeer = %+v, want {peerId=%s}",
			acceptedB.RemotePeer, peerA)
	}

	// Both A and B receive peer_presence_changed(subject=B).
	_, rawA := a.expect(proto.TypePeerPresenceChanged)
	presA := parsePayload[proto.PeerPresenceChangedPayload](t, rawA)
	if presA.SubjectPeerID != acceptedB.PeerID {
		t.Fatalf("A presence subject=%s, want %s", presA.SubjectPeerID, acceptedB.PeerID)
	}
	if presA.Presence != proto.PresencePendingMedia || presA.Reason != proto.PresenceReasonAdmitted {
		t.Fatalf("A presence = {presence:%s reason:%s}, want {pending-media, admitted}",
			presA.Presence, presA.Reason)
	}

	_, rawB := b.expect(proto.TypePeerPresenceChanged)
	presB := parsePayload[proto.PeerPresenceChangedPayload](t, rawB)
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
	_, _ = a.expect(proto.TypePeerPresenceChanged)

	c := dialClient(t, ts)
	c.send(joinRoomMsg("demo", newRequestID()))

	_, raw := c.expect(proto.TypeJoinRejected)
	rej := parsePayload[proto.JoinRejectedPayload](t, raw)
	if rej.Result != proto.JoinRejectedRoomFull {
		t.Fatalf("third join result=%q, want join_rejected_room_full", rej.Result)
	}
	if rej.Reason != proto.ReasonRoomFull {
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

	_, raw := c.expect(proto.TypeJoinRejected)
	rej := parsePayload[proto.JoinRejectedPayload](t, raw)
	if rej.Result != proto.JoinRejectedInvalidRoom {
		t.Fatalf("result=%q, want join_rejected_invalid_room", rej.Result)
	}
	if rej.Reason != proto.ReasonInvalidRoomID {
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
	_, _ = a.expect(proto.TypePeerPresenceChanged)

	b.send(leaveRoomMsg("demo"))

	// A should observe peer_presence_changed(presence=released,
	// reason=graceful_leave). It MUST NOT receive peer_left, because
	// B never reached callPhase ∈ {role-assigned, negotiating,
	// connected}.
	_, raw := a.expect(proto.TypePeerPresenceChanged)
	pres := parsePayload[proto.PeerPresenceChangedPayload](t, raw)
	if pres.Presence != proto.PresenceReleased {
		t.Fatalf("presence=%q, want released", pres.Presence)
	}
	if pres.Reason != proto.PresenceReasonGracefulLeave {
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
	_, _ = a.expect(proto.TypePeerPresenceChanged)

	b.send(leaveRoomMsg("demo"))

	_, raw := a.expect(proto.TypePeerPresenceChanged)
	pres := parsePayload[proto.PeerPresenceChangedPayload](t, raw)
	if pres.Presence == proto.PresenceLeft {
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
	_, _ = a.expect(proto.TypePeerPresenceChanged)

	// Ungraceful close: abort B's WS without sending leave_room.
	_ = b.conn.Close(websocket.StatusAbnormalClosure, "test disconnect")

	_, raw := a.expect(proto.TypePeerPresenceChanged)
	pres := parsePayload[proto.PeerPresenceChangedPayload](t, raw)
	if pres.Presence != proto.PresenceReleased {
		t.Fatalf("presence=%q, want released (pre-pairing disconnect)", pres.Presence)
	}
	if pres.Reason != proto.PresenceReasonDisconnect {
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
//  1. A (remaining) sees a peer_presence_changed(released,
//     graceful_leave).
//  2. B's next Read reports a close status (not a generic read
//     error, not context cancellation).
//
// Asserting on the readable side is the robust signal; "next Write
// fails" would race the close handshake.
func TestLeaveRoomClosesWSAndNotifiesPeer(t *testing.T) {
	ts := flowServer(t)

	a := dialClient(t, ts)
	a.joinAndAck("demo", newRequestID())

	b := dialClient(t, ts)
	b.joinAndAck("demo", newRequestID())
	_, _ = a.expect(proto.TypePeerPresenceChanged) // drain B's admit event on A

	b.send(leaveRoomMsg("demo"))

	// (1) A sees the presence event.
	_, raw := a.expect(proto.TypePeerPresenceChanged)
	pres := parsePayload[proto.PeerPresenceChangedPayload](t, raw)
	if pres.Presence != proto.PresenceReleased {
		t.Fatalf("A presence=%q, want released", pres.Presence)
	}
	if pres.Reason != proto.PresenceReasonGracefulLeave {
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

	env, raw := c.expect(proto.TypeError)
	payload := parsePayload[proto.ErrorPayload](t, raw)
	if payload.Code != proto.CodeMalformed {
		t.Fatalf("error.code=%q want malformed", payload.Code)
	}
	_ = env
}

// ---------------------------------------------------------------------
// Phase 4 — media-ready pairing, role assignment, offer/answer relay
// ---------------------------------------------------------------------

// mediaReadyMsg crafts a §3.5 envelope with explicit audio/video
// booleans so capability-rejection tests can flip either one to
// false.
func mediaReadyMsg(roomID string, audio, video bool) any {
	return map[string]any{
		"v":      1,
		"type":   "media_ready",
		"roomId": roomID,
		"payload": map[string]any{
			"mediaCapabilities": map[string]any{
				"audio": audio,
				"video": video,
			},
		},
	}
}

func mediaFailedMsg(roomID, reason string) any {
	return map[string]any{
		"v":       1,
		"type":    "media_failed",
		"roomId":  roomID,
		"payload": map[string]any{"reason": reason},
	}
}

func offerMsg(roomID, sdpStr string) any {
	return map[string]any{
		"v":      1,
		"type":   "offer",
		"roomId": roomID,
		"payload": map[string]any{
			"sdp": map[string]any{"type": "offer", "sdp": sdpStr},
		},
	}
}

func answerMsg(roomID, sdpStr string) any {
	return map[string]any{
		"v":      1,
		"type":   "answer",
		"roomId": roomID,
		"payload": map[string]any{
			"sdp": map[string]any{"type": "answer", "sdp": sdpStr},
		},
	}
}

// joinBoth admits both clients to the same room and drains the
// cross-peer admission events so each client's read queue starts
// empty relative to Phase 4 events.
func joinBoth(t *testing.T, a, b *testClient, roomID string) (peerA, peerB string) {
	t.Helper()
	peerA = a.joinAndAck(roomID, newRequestID())
	peerB = b.joinAndAck(roomID, newRequestID())
	// A sees B's admission presence event.
	_, _ = a.expect(proto.TypePeerPresenceChanged)
	return peerA, peerB
}

// bothReady drives both clients through media_ready so the room
// reaches paired. Returns each client's ready_for_offer payload.
// The sequence is:
//
//	A media_ready → presence(A, ready) to {A, B}
//	B media_ready → presence(B, ready) to {A, B} → paired
//	             → ready_for_offer to {A, B}
//
// Any extra message in a client's queue when this returns is a bug
// either in the server or this helper.
func bothReady(t *testing.T, a, b *testClient, roomID string) (proto.ReadyForOfferPayload, proto.ReadyForOfferPayload) {
	t.Helper()

	a.send(mediaReadyMsg(roomID, true, true))
	// presence(A, ready) fans out to both A and B.
	_, _ = a.expect(proto.TypePeerPresenceChanged)
	_, _ = b.expect(proto.TypePeerPresenceChanged)

	b.send(mediaReadyMsg(roomID, true, true))
	// presence(B, ready) fans out to both A and B.
	_, _ = a.expect(proto.TypePeerPresenceChanged)
	_, _ = b.expect(proto.TypePeerPresenceChanged)

	_, rawA := a.expect(proto.TypeReadyForOffer)
	_, rawB := b.expect(proto.TypeReadyForOffer)
	return parsePayload[proto.ReadyForOfferPayload](t, rawA),
		parsePayload[proto.ReadyForOfferPayload](t, rawB)
}

// ---------------------------------------------------------------------
// T029 — media_ready / media_failed
// ---------------------------------------------------------------------

func TestMediaReadyRejectsIncompleteCapabilities(t *testing.T) {
	ts := flowServer(t)
	a := dialClient(t, ts)
	_ = a.joinAndAck("demo", newRequestID())

	// audio=false MUST be rejected — contract §3.5.
	a.send(mediaReadyMsg("demo", false, true))
	_, raw := a.expect(proto.TypeError)
	payload := parsePayload[proto.ErrorPayload](t, raw)
	if payload.Code != proto.CodeUnsupportedMediaCapability {
		t.Fatalf("audio=false: error.code=%q want unsupported_media_capability", payload.Code)
	}

	// video=false MUST be rejected too.
	a.send(mediaReadyMsg("demo", true, false))
	_, raw = a.expect(proto.TypeError)
	payload = parsePayload[proto.ErrorPayload](t, raw)
	if payload.Code != proto.CodeUnsupportedMediaCapability {
		t.Fatalf("video=false: error.code=%q want unsupported_media_capability", payload.Code)
	}
}

func TestMediaReadyAdvancesToReady(t *testing.T) {
	ts := flowServer(t)
	a := dialClient(t, ts)
	peerA := a.joinAndAck("demo", newRequestID())

	a.send(mediaReadyMsg("demo", true, true))

	_, raw := a.expect(proto.TypePeerPresenceChanged)
	pres := parsePayload[proto.PeerPresenceChangedPayload](t, raw)
	if pres.SubjectPeerID != peerA {
		t.Fatalf("subject=%s want %s", pres.SubjectPeerID, peerA)
	}
	if pres.Presence != proto.PresenceReady {
		t.Fatalf("presence=%q want ready", pres.Presence)
	}
	if pres.Reason != proto.PresenceReasonMediaReady {
		t.Fatalf("reason=%q want media_ready", pres.Reason)
	}

	// A second media_ready from the same peer MUST be rejected — the
	// sender's mediaReadiness is already `ready`.
	a.send(mediaReadyMsg("demo", true, true))
	_, rawErr := a.expect(proto.TypeError)
	perr := parsePayload[proto.ErrorPayload](t, rawErr)
	if perr.Code != proto.CodeUnexpectedMediaReady {
		t.Fatalf("second media_ready: error.code=%q want unexpected_media_ready", perr.Code)
	}

	// No ready_for_offer yet — room has only one participant.
	a.expectNone(200 * time.Millisecond)
}

// ---------------------------------------------------------------------
// T030 — participant_released (post-admission) + retry support
// ---------------------------------------------------------------------

func TestMediaFailedAllowsRetry(t *testing.T) {
	ts := flowServer(t)
	b := dialClient(t, ts)
	_ = b.joinAndAck("demo", newRequestID())

	b.send(mediaFailedMsg("demo", "permission_denied"))

	// B receives its own participant_released.
	_, raw := b.expect(proto.TypeParticipantReleased)
	rel := parsePayload[proto.ParticipantReleasedPayload](t, raw)
	if rel.Result != proto.ParticipantReleasedMediaFailed {
		t.Fatalf("result=%q want participant_released_media_failed", rel.Result)
	}
	if rel.Reason != proto.ReleasedReasonMediaFailed {
		t.Fatalf("reason=%q want media_failed", rel.Reason)
	}

	// Same WS MUST be able to send another join_room without
	// already_joined (contract §3.13 server-side retry support).
	b.send(joinRoomMsg("demo", newRequestID()))
	_, rawAcc := b.expect(proto.TypeJoinAccepted)
	acc := parsePayload[proto.JoinAcceptedPayload](t, rawAcc)
	if acc.PeerID == "" {
		t.Fatalf("retry join_accepted: peerID empty")
	}
	// And the self-presence(pending-media, admitted) arrives too.
	_, _ = b.expect(proto.TypePeerPresenceChanged)
}

func TestParticipantReleasedBroadcastsToRemaining(t *testing.T) {
	ts := flowServer(t)
	a := dialClient(t, ts)
	b := dialClient(t, ts)
	peerA, peerB := joinBoth(t, a, b, "demo")
	_ = peerA

	b.send(mediaFailedMsg("demo", "device_in_use"))

	// B receives participant_released.
	_, _ = b.expect(proto.TypeParticipantReleased)

	// A receives peer_presence_changed(released, media_failed) and
	// NO peer_left — pending-media release is pre-pairing by
	// definition.
	_, raw := a.expect(proto.TypePeerPresenceChanged)
	pres := parsePayload[proto.PeerPresenceChangedPayload](t, raw)
	if pres.SubjectPeerID != peerB {
		t.Fatalf("subject=%s want %s", pres.SubjectPeerID, peerB)
	}
	if pres.Presence != proto.PresenceReleased {
		t.Fatalf("presence=%q want released", pres.Presence)
	}
	if pres.Reason != proto.PresenceReasonMediaFailed {
		t.Fatalf("reason=%q want media_failed", pres.Reason)
	}
	a.expectNone(200 * time.Millisecond)
}

// ---------------------------------------------------------------------
// T031 — ready_for_offer exactly once, role by admissionOrder
// ---------------------------------------------------------------------

func TestReadyForOfferSentExactlyOncePerPairing(t *testing.T) {
	ts := flowServer(t)
	a := dialClient(t, ts)
	b := dialClient(t, ts)
	_, _ = joinBoth(t, a, b, "demo")

	_, _ = bothReady(t, a, b, "demo")

	// A second media_ready from either peer MUST be rejected with
	// unexpected_media_ready and MUST NOT trigger a second
	// ready_for_offer (rolesAssigned guard).
	a.send(mediaReadyMsg("demo", true, true))
	_, rawErr := a.expect(proto.TypeError)
	perr := parsePayload[proto.ErrorPayload](t, rawErr)
	if perr.Code != proto.CodeUnexpectedMediaReady {
		t.Fatalf("repeat media_ready: error.code=%q want unexpected_media_ready", perr.Code)
	}
	a.expectNone(200 * time.Millisecond)
	b.expectNone(200 * time.Millisecond)
}

func TestOffererIsLowerAdmissionOrder(t *testing.T) {
	ts := flowServer(t)
	a := dialClient(t, ts)
	b := dialClient(t, ts)
	peerA, peerB := joinBoth(t, a, b, "demo")

	payloadA, payloadB := bothReady(t, a, b, "demo")

	// A was admitted first → order 1 → offerer.
	if payloadA.Role != proto.RoleOfferer {
		t.Fatalf("A role=%q want offerer", payloadA.Role)
	}
	if payloadA.RemotePeer.PeerID != peerB {
		t.Fatalf("A remotePeer.peerId=%s want %s", payloadA.RemotePeer.PeerID, peerB)
	}
	if payloadA.RemotePeer.AdmissionOrder != 2 {
		t.Fatalf("A remotePeer.admissionOrder=%d want 2", payloadA.RemotePeer.AdmissionOrder)
	}
	if len(payloadA.IceServers) == 0 {
		t.Fatalf("A iceServers empty; expected STUN fallback at minimum")
	}

	// B was admitted second → order 2 → answerer.
	if payloadB.Role != proto.RoleAnswerer {
		t.Fatalf("B role=%q want answerer", payloadB.Role)
	}
	if payloadB.RemotePeer.PeerID != peerA {
		t.Fatalf("B remotePeer.peerId=%s want %s", payloadB.RemotePeer.PeerID, peerA)
	}
}

// ---------------------------------------------------------------------
// T033 — pending-media disconnect / leave releases slot, NO peer_left
// ---------------------------------------------------------------------

func TestPendingMediaDisconnectReleasesSlotNoPeerLeft(t *testing.T) {
	ts := flowServer(t)
	a := dialClient(t, ts)
	b := dialClient(t, ts)
	_, peerB := joinBoth(t, a, b, "demo")

	// A is media-ready but still waiting for B to send media_ready.
	// B is pending-media.
	a.send(mediaReadyMsg("demo", true, true))
	_, _ = a.expect(proto.TypePeerPresenceChanged)
	_, _ = b.expect(proto.TypePeerPresenceChanged)

	// B disconnects ungracefully while pending-media.
	_ = b.conn.Close(websocket.StatusAbnormalClosure, "test disconnect")

	_, raw := a.expect(proto.TypePeerPresenceChanged)
	pres := parsePayload[proto.PeerPresenceChangedPayload](t, raw)
	if pres.SubjectPeerID != peerB {
		t.Fatalf("subject=%s want %s", pres.SubjectPeerID, peerB)
	}
	if pres.Presence != proto.PresenceReleased {
		t.Fatalf("presence=%q want released", pres.Presence)
	}
	if pres.Reason != proto.PresenceReasonDisconnect {
		t.Fatalf("reason=%q want disconnect", pres.Reason)
	}
	// Must NOT emit peer_left for a pending-media departure.
	a.expectNone(300 * time.Millisecond)
}

func TestPendingMediaReleaseDoesNotEmitPeerLeft(t *testing.T) {
	ts := flowServer(t)
	a := dialClient(t, ts)
	b := dialClient(t, ts)
	_, _ = joinBoth(t, a, b, "demo")

	// A is media-ready; B is still pending-media. B gracefully leaves.
	a.send(mediaReadyMsg("demo", true, true))
	_, _ = a.expect(proto.TypePeerPresenceChanged)
	_, _ = b.expect(proto.TypePeerPresenceChanged)

	b.send(leaveRoomMsg("demo"))

	_, raw := a.expect(proto.TypePeerPresenceChanged)
	pres := parsePayload[proto.PeerPresenceChangedPayload](t, raw)
	if pres.Presence != proto.PresenceReleased {
		t.Fatalf("presence=%q want released (pending-media graceful leave)", pres.Presence)
	}
	if pres.Reason != proto.PresenceReasonGracefulLeave {
		t.Fatalf("reason=%q want graceful_leave", pres.Reason)
	}
	a.expectNone(300 * time.Millisecond)
}

// ---------------------------------------------------------------------
// T034B — offer / answer relay, callPhase advance, glare guard
// ---------------------------------------------------------------------

func TestOfferFromOffererRelayed(t *testing.T) {
	ts := flowServer(t)
	a := dialClient(t, ts)
	b := dialClient(t, ts)
	peerA, peerB := joinBoth(t, a, b, "demo")
	_, _ = bothReady(t, a, b, "demo")

	a.send(offerMsg("demo", "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n"))

	env, raw := b.expect(proto.TypeOffer)
	if env.From != peerA {
		t.Fatalf("offer envelope.from=%s want %s", env.From, peerA)
	}
	if env.To != "" && env.To != peerB {
		t.Fatalf("offer envelope.to=%s want '' or %s", env.To, peerB)
	}
	offer := parsePayload[proto.OfferPayload](t, raw)
	if offer.SDP.Type != "offer" {
		t.Fatalf("sdp.type=%q want offer", offer.SDP.Type)
	}
	// Sender receives no echo.
	a.expectNone(200 * time.Millisecond)
}

func TestOfferFromAnswererRejected(t *testing.T) {
	ts := flowServer(t)
	a := dialClient(t, ts)
	b := dialClient(t, ts)
	_, _ = joinBoth(t, a, b, "demo")
	_, _ = bothReady(t, a, b, "demo")

	// B is answerer — any offer from B MUST be rejected with
	// unexpected_offer and MUST NOT be relayed to A.
	b.send(offerMsg("demo", "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n"))

	_, raw := b.expect(proto.TypeError)
	perr := parsePayload[proto.ErrorPayload](t, raw)
	if perr.Code != proto.CodeUnexpectedOffer {
		t.Fatalf("error.code=%q want unexpected_offer", perr.Code)
	}
	a.expectNone(200 * time.Millisecond)
}

func TestDuplicateOfferRejected(t *testing.T) {
	ts := flowServer(t)
	a := dialClient(t, ts)
	b := dialClient(t, ts)
	_, _ = joinBoth(t, a, b, "demo")
	_, _ = bothReady(t, a, b, "demo")

	a.send(offerMsg("demo", "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n"))
	// Drain B's first relay.
	_, _ = b.expect(proto.TypeOffer)

	// Second offer for the same pairing MUST be rejected.
	a.send(offerMsg("demo", "v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\n"))

	_, raw := a.expect(proto.TypeError)
	perr := parsePayload[proto.ErrorPayload](t, raw)
	if perr.Code != proto.CodeUnexpectedOffer {
		t.Fatalf("duplicate offer: error.code=%q want unexpected_offer", perr.Code)
	}
	// B MUST NOT receive the duplicate.
	b.expectNone(200 * time.Millisecond)
}

func TestAnswerFromAnswererRelayed(t *testing.T) {
	ts := flowServer(t)
	a := dialClient(t, ts)
	b := dialClient(t, ts)
	peerA, peerB := joinBoth(t, a, b, "demo")
	_, _ = bothReady(t, a, b, "demo")

	// Drive a complete offer first so the peers are mid-negotiation.
	a.send(offerMsg("demo", "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n"))
	_, _ = b.expect(proto.TypeOffer)

	b.send(answerMsg("demo", "v=0\r\no=- 3 3 IN IP4 127.0.0.1\r\n"))

	env, raw := a.expect(proto.TypeAnswer)
	if env.From != peerB {
		t.Fatalf("answer envelope.from=%s want %s", env.From, peerB)
	}
	if env.To != "" && env.To != peerA {
		t.Fatalf("answer envelope.to=%s want '' or %s", env.To, peerA)
	}
	ans := parsePayload[proto.AnswerPayload](t, raw)
	if ans.SDP.Type != "answer" {
		t.Fatalf("sdp.type=%q want answer", ans.SDP.Type)
	}
	b.expectNone(200 * time.Millisecond)
}

func TestAnswerFromOffererRejected(t *testing.T) {
	ts := flowServer(t)
	a := dialClient(t, ts)
	b := dialClient(t, ts)
	_, _ = joinBoth(t, a, b, "demo")
	_, _ = bothReady(t, a, b, "demo")

	// A is offerer — any answer from A MUST be rejected.
	a.send(answerMsg("demo", "v=0\r\no=- 3 3 IN IP4 127.0.0.1\r\n"))

	_, raw := a.expect(proto.TypeError)
	perr := parsePayload[proto.ErrorPayload](t, raw)
	if perr.Code != proto.CodeUnexpectedAnswer {
		t.Fatalf("error.code=%q want unexpected_answer", perr.Code)
	}
	b.expectNone(200 * time.Millisecond)
}

// TestCallPhaseAdvancesOnOffer verifies that once the offerer sends
// a valid offer, its callPhase advances (role-assigned → negotiating)
// and a second offer is rejected on that basis. The observable proxy
// is: duplicate offer is rejected.
func TestCallPhaseAdvancesOnOffer(t *testing.T) {
	ts := flowServer(t)
	a := dialClient(t, ts)
	b := dialClient(t, ts)
	_, _ = joinBoth(t, a, b, "demo")
	_, _ = bothReady(t, a, b, "demo")

	a.send(offerMsg("demo", "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n"))
	_, _ = b.expect(proto.TypeOffer)

	// Without any answer, send another offer. Since the first accepted
	// offer advances callPhase to negotiating, the second is rejected
	// by the duplicate guard — observable evidence of the advance.
	a.send(offerMsg("demo", "v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\n"))
	_, raw := a.expect(proto.TypeError)
	perr := parsePayload[proto.ErrorPayload](t, raw)
	if perr.Code != proto.CodeUnexpectedOffer {
		t.Fatalf("second offer in negotiating: error.code=%q want unexpected_offer", perr.Code)
	}
}

// TestNoGlare_OnlyOffererSendsOffer guards R-3: the server rejects
// `offer` from the non-offerer peer even if sent racily. A's
// relayed-offer and B's own rejection error can arrive in either
// order on B's queue depending on goroutine scheduling — we only
// require that both are present and exactly one is the rejection.
func TestNoGlare_OnlyOffererSendsOffer(t *testing.T) {
	ts := flowServer(t)
	a := dialClient(t, ts)
	b := dialClient(t, ts)
	_, _ = joinBoth(t, a, b, "demo")
	_, _ = bothReady(t, a, b, "demo")

	// Both try to send an offer simultaneously. Only A (offerer) is
	// allowed to; B is rejected.
	a.send(offerMsg("demo", "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n"))
	b.send(offerMsg("demo", "v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\n"))

	// Consume exactly two frames on B's queue; they MUST be one
	// `offer` (relayed from A) and one `error` (B's rejection).
	sawOffer, sawError := false, false
	for i := 0; i < 2; i++ {
		rctx, cancel := context.WithTimeout(b.ctx, 2*time.Second)
		_, raw, err := b.conn.Read(rctx)
		cancel()
		if err != nil {
			t.Fatalf("B read %d: %v", i, err)
		}
		var env proto.Envelope
		if err := json.Unmarshal(raw, &env); err != nil {
			t.Fatalf("B unmarshal: %v", err)
		}
		switch env.Type {
		case proto.TypeOffer:
			sawOffer = true
		case proto.TypeError:
			sawError = true
			perr := parsePayload[proto.ErrorPayload](t, env.Payload)
			if perr.Code != proto.CodeUnexpectedOffer {
				t.Fatalf("B error.code=%q want unexpected_offer", perr.Code)
			}
		default:
			t.Fatalf("B unexpected frame type %q raw=%s", env.Type, string(raw))
		}
	}
	if !sawOffer || !sawError {
		t.Fatalf("expected both relayed offer and rejection; got offer=%v error=%v",
			sawOffer, sawError)
	}
	// A must NOT have received B's forbidden offer.
	a.expectNone(200 * time.Millisecond)
}

// TestOnlyOffererSendsOffer — T056 / Phase 7 glare guard.
//
// Consolidates the two sides of "only the offerer may send an offer
// per pairing attempt" into a single named test:
//
//  1. The answerer (higher admissionOrder) attempting to send `offer`
//     MUST be rejected with `error{code:"unexpected_offer"}` and MUST
//     NOT be relayed to the offerer.
//  2. The offerer may send exactly one offer per pairing attempt; a
//     second offer from the same offerer in the same pairing MUST be
//     rejected with the same error code.
//
// Companion tests `TestOfferFromAnswererRejected`,
// `TestDuplicateOfferRejected`, and `TestNoGlare_OnlyOffererSendsOffer`
// cover each rejection in isolation + the racing-concurrent case; this
// test exists to satisfy T056's exact-named requirement and exercise
// both assertions against a single pairing.
func TestOnlyOffererSendsOffer(t *testing.T) {
	ts := flowServer(t)
	a := dialClient(t, ts) // admissionOrder=1 → offerer
	b := dialClient(t, ts) // admissionOrder=2 → answerer
	_, _ = joinBoth(t, a, b, "demo")
	_, _ = bothReady(t, a, b, "demo")

	// (1) Answerer attempts to send `offer` — must be rejected with
	// unexpected_offer. The "A does not receive the forbidden offer"
	// half of this assertion is covered by the terminal expectNone on
	// A at the end of the test; we cannot expectNone on A here
	// because further sends on A would follow, and expectNone leaves
	// a Read goroutine parked that would race those sends.
	b.send(offerMsg("demo", "v=0\r\no=- 10 10 IN IP4 127.0.0.1\r\n"))
	_, rawErrB := b.expect(proto.TypeError)
	peB := parsePayload[proto.ErrorPayload](t, rawErrB)
	if peB.Code != proto.CodeUnexpectedOffer {
		t.Fatalf("answerer offer: code=%q want unexpected_offer", peB.Code)
	}

	// (2) Offerer sends a valid first offer — relayed to B.
	a.send(offerMsg("demo", "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n"))
	_, _ = b.expect(proto.TypeOffer)

	// (3) Offerer sends a second offer in the same pairing — server
	// must reject the duplicate with unexpected_offer.
	a.send(offerMsg("demo", "v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\n"))
	_, rawErrA := a.expect(proto.TypeError)
	peA := parsePayload[proto.ErrorPayload](t, rawErrA)
	if peA.Code != proto.CodeUnexpectedOffer {
		t.Fatalf("duplicate offer: code=%q want unexpected_offer", peA.Code)
	}

	// Terminal per-client assertions:
	// - A must not have received B's forbidden offer (step 1) nor an
	//   echo of A's own accepted offer (step 2) nor any relay of A's
	//   duplicate (step 3).
	// - B must not have received a second `offer` relay (step 3).
	a.expectNone(200 * time.Millisecond)
	b.expectNone(200 * time.Millisecond)
}

// ---------------------------------------------------------------------
// T063A — ice_candidate relay
// ---------------------------------------------------------------------

// iceCandidateMsg builds a §3.10 envelope carrying a populated
// candidate. The candidate string is opaque to the contract layer —
// tests use a distinctive marker so log-safety assertions can grep for
// it.
func iceCandidateMsg(roomID, candidateStr, sdpMid string, sdpMLineIndex int) any {
	return map[string]any{
		"v":      1,
		"type":   "ice_candidate",
		"roomId": roomID,
		"payload": map[string]any{
			"candidate": map[string]any{
				"candidate":     candidateStr,
				"sdpMid":        sdpMid,
				"sdpMLineIndex": sdpMLineIndex,
			},
		},
	}
}

func iceCandidateNullMsg(roomID string) any {
	return map[string]any{
		"v":      1,
		"type":   "ice_candidate",
		"roomId": roomID,
		"payload": map[string]any{
			"candidate": nil,
		},
	}
}

func iceCandidateEmptyMsg(roomID string) any {
	return map[string]any{
		"v":      1,
		"type":   "ice_candidate",
		"roomId": roomID,
		"payload": map[string]any{
			"candidate": map[string]any{
				"candidate":     "",
				"sdpMid":        "0",
				"sdpMLineIndex": 0,
			},
		},
	}
}

func TestIceCandidateRelayed(t *testing.T) {
	ts := flowServer(t)
	a := dialClient(t, ts)
	b := dialClient(t, ts)
	peerA, peerB := joinBoth(t, a, b, "demo")
	_, _ = bothReady(t, a, b, "demo")

	const candStr = "candidate:1 1 UDP 2130706431 192.0.2.10 54321 typ host"
	a.send(iceCandidateMsg("demo", candStr, "0", 0))

	env, raw := b.expect(proto.TypeIceCandidate)
	if env.From != peerA {
		t.Fatalf("ice_candidate envelope.from=%s want %s", env.From, peerA)
	}
	if env.To != "" && env.To != peerB {
		t.Fatalf("ice_candidate envelope.to=%s want '' or %s", env.To, peerB)
	}
	pc := parsePayload[proto.IceCandidatePayload](t, raw)
	if pc.Candidate == nil {
		t.Fatalf("relayed payload.candidate=nil, want populated candidate")
	}
	// Server must forward the body byte-for-byte — NFR-003.
	if pc.Candidate.Candidate != candStr {
		t.Fatalf("relayed candidate=%q, want %q", pc.Candidate.Candidate, candStr)
	}
	// Sender never sees an echo of its own candidate.
	a.expectNone(200 * time.Millisecond)
}

func TestIceCandidateNullRelayed(t *testing.T) {
	ts := flowServer(t)
	a := dialClient(t, ts)
	b := dialClient(t, ts)
	_, _ = joinBoth(t, a, b, "demo")
	_, _ = bothReady(t, a, b, "demo")

	// End-of-candidates marker — contract §3.10: relay identically.
	a.send(iceCandidateNullMsg("demo"))
	_, raw := b.expect(proto.TypeIceCandidate)
	pc := parsePayload[proto.IceCandidatePayload](t, raw)
	if pc.Candidate != nil {
		t.Fatalf("end-of-candidates relay: Candidate=%+v, want nil", pc.Candidate)
	}
}

func TestIceCandidateEmptyRejected(t *testing.T) {
	ts := flowServer(t)
	a := dialClient(t, ts)
	b := dialClient(t, ts)
	_, _ = joinBoth(t, a, b, "demo")
	_, _ = bothReady(t, a, b, "demo")

	// `candidate: ""` is explicitly malformed per §3.10. `null` is the
	// only valid end-of-candidates form. Decode-level validation fires
	// before dispatch, so the sender gets `error{code:"malformed"}`
	// and the remote peer sees nothing.
	a.send(iceCandidateEmptyMsg("demo"))
	_, rawErr := a.expect(proto.TypeError)
	pe := parsePayload[proto.ErrorPayload](t, rawErr)
	if pe.Code != proto.CodeMalformed {
		t.Fatalf("empty candidate: code=%q want malformed", pe.Code)
	}
	b.expectNone(200 * time.Millisecond)
}

func TestIceCandidateFromWrongStateRejected(t *testing.T) {
	ts := flowServer(t)
	a := dialClient(t, ts)
	_ = a.joinAndAck("demo", newRequestID())

	// A joined but has not sent media_ready yet, so callPhase is
	// `idle` and mediaReadiness is `pending-media`. Per §3.10 +
	// §C.2 the server MUST reject ice_candidate with `malformed`
	// (via CanSendIceCandidate). No broadcast should occur — there's
	// no remote peer to begin with, but the assertion is the error
	// code + CanSendIceCandidate's rejection being exercised.
	const candStr = "candidate:1 1 UDP 100 1.2.3.4 5678 typ host"
	a.send(iceCandidateMsg("demo", candStr, "0", 0))
	_, raw := a.expect(proto.TypeError)
	pe := parsePayload[proto.ErrorPayload](t, raw)
	if pe.Code != proto.CodeMalformed {
		t.Fatalf("pre-ready candidate: code=%q want malformed", pe.Code)
	}
}

// TestServerNeverLogsCandidate asserts the server never emits the raw
// candidate string to any log handler. We send a candidate with a
// distinctive marker, then read the captured structured logs and grep
// for the marker. Missing = pass; present = NFR-003 violation.
func TestServerNeverLogsCandidate(t *testing.T) {
	log, buf := captureLogger()
	h := sig.NewHandler(log)
	h.Heartbeat = sig.HeartbeatConfig{
		PingInterval: 10 * time.Second,
		PongTimeout:  10 * time.Second,
	}
	ts := httptest.NewServer(h)
	t.Cleanup(func() { ts.Close() })
	// If the test fails, surface the buffer for debugging. We intentionally
	// only log on failure to avoid false positives from the ctrl-c path.
	t.Cleanup(func() {
		if t.Failed() {
			t.Logf("server log:\n%s", buf.String())
		}
	})

	a := dialClient(t, ts)
	b := dialClient(t, ts)
	_, _ = joinBoth(t, a, b, "demo")
	_, _ = bothReady(t, a, b, "demo")

	// A deliberately unique marker — if this substring shows up in
	// the server's log buffer the test fails and we've leaked the
	// candidate payload.
	const marker = "CAND-MARKER-9d5a7e2b1f0c4"
	const candStr = "candidate:1 1 UDP 2130706431 10.0.0.1 12345 typ host " + marker
	a.send(iceCandidateMsg("demo", candStr, "0", 0))
	_, _ = b.expect(proto.TypeIceCandidate) // drain the relay so we know dispatch ran

	// Give the server a beat to flush the "ice_candidate relayed"
	// structured log. 50ms is plenty on loopback; we are not waiting
	// on any async timer.
	time.Sleep(50 * time.Millisecond)

	logs := buf.String()
	if strings.Contains(logs, marker) {
		t.Fatalf("server logged the candidate string (NFR-003 violation). log:\n%s", logs)
	}
	// Sanity: the structured ice-relay log entry DID fire (so the
	// grep above is meaningful).
	if !strings.Contains(logs, `"event":"ice_candidate_relay"`) {
		t.Fatalf("ice_candidate_relay log line missing; grep is meaningless. log:\n%s", logs)
	}
}

// ---------------------------------------------------------------------
// T074A — media_state relay (Phase 10)
// ---------------------------------------------------------------------

// mediaStateMsg builds a §3.11 envelope with the full triplet.
func mediaStateMsg(roomID, mic, cam, screen string) any {
	return map[string]any{
		"v":      1,
		"type":   "media_state",
		"roomId": roomID,
		"payload": map[string]any{
			"microphone":  mic,
			"camera":      cam,
			"screenShare": screen,
		},
	}
}

// TestMediaStateRelayedToRemoteOnly asserts a valid media_state from a
// media-ready, role-assigned sender is relayed verbatim to the remote
// peer with envelope.from = sender.peerID, and that the sender does
// NOT receive an echo.
func TestMediaStateRelayedToRemoteOnly(t *testing.T) {
	ts := flowServer(t)
	a := dialClient(t, ts)
	b := dialClient(t, ts)
	peerA, peerB := joinBoth(t, a, b, "demo")
	_, _ = bothReady(t, a, b, "demo")

	a.send(mediaStateMsg("demo", "off", "on", "inactive"))

	env, raw := b.expect(proto.TypeMediaState)
	if env.From != peerA {
		t.Fatalf("media_state envelope.from=%s want %s", env.From, peerA)
	}
	if env.To != "" && env.To != peerB {
		t.Fatalf("media_state envelope.to=%s want '' or %s", env.To, peerB)
	}
	ms := parsePayload[proto.MediaStatePayload](t, raw)
	if ms.Microphone != "off" || ms.Camera != "on" || ms.ScreenShare != "inactive" {
		t.Fatalf("relayed payload=%+v want {off,on,inactive}", ms)
	}
	// Sender never receives its own echo.
	a.expectNone(200 * time.Millisecond)
}

// TestMediaStateRejectedFromPendingMedia asserts a sender that has not
// yet reached mediaReadiness=ready cannot emit media_state — the
// server rejects with `error{code:"malformed"}` and MUST NOT relay.
func TestMediaStateRejectedFromPendingMedia(t *testing.T) {
	ts := flowServer(t)
	a := dialClient(t, ts)
	b := dialClient(t, ts)
	_, _ = joinBoth(t, a, b, "demo")

	// Neither peer has sent media_ready yet; both are pending-media /
	// idle. A's attempt to send media_state must be rejected.
	a.send(mediaStateMsg("demo", "on", "on", "inactive"))

	_, raw := a.expect(proto.TypeError)
	pe := parsePayload[proto.ErrorPayload](t, raw)
	if pe.Code != proto.CodeMalformed {
		t.Fatalf("pending-media media_state: code=%q want malformed", pe.Code)
	}
	// B MUST NOT receive any relayed media_state.
	b.expectNone(200 * time.Millisecond)
}

// TestMediaStateRequiresFullTriplet asserts that payloads missing any
// of the three fields are rejected by envelope-level validation with
// `error{code:"malformed"}` (§3.11: "All three fields are required in
// every media_state message").
func TestMediaStateRequiresFullTriplet(t *testing.T) {
	ts := flowServer(t)
	a := dialClient(t, ts)
	b := dialClient(t, ts)
	_, _ = joinBoth(t, a, b, "demo")
	_, _ = bothReady(t, a, b, "demo")

	cases := []struct {
		name    string
		payload map[string]any
	}{
		{"missing screenShare", map[string]any{"microphone": "on", "camera": "on"}},
		{"missing camera", map[string]any{"microphone": "on", "screenShare": "inactive"}},
		{"missing microphone", map[string]any{"camera": "on", "screenShare": "inactive"}},
	}
	for _, tc := range cases {
		a.send(map[string]any{
			"v":       1,
			"type":    "media_state",
			"roomId":  "demo",
			"payload": tc.payload,
		})
		_, raw := a.expect(proto.TypeError)
		pe := parsePayload[proto.ErrorPayload](t, raw)
		if pe.Code != proto.CodeMalformed {
			t.Fatalf("%s: code=%q want malformed", tc.name, pe.Code)
		}
	}
	// The remote peer must NOT have received any of the partial
	// messages as a relay.
	b.expectNone(200 * time.Millisecond)
}

// TestInCallLeaveEmitsPeerLeft verifies the in-call classification
// branch of §C.6 step 5: a departing peer that reached callPhase ∈
// {role-assigned, negotiating, connected} MUST produce peer_left to
// the remaining peer.
func TestInCallLeaveEmitsPeerLeft(t *testing.T) {
	ts := flowServer(t)
	a := dialClient(t, ts)
	b := dialClient(t, ts)
	peerA, peerB := joinBoth(t, a, b, "demo")
	_ = peerA
	_, _ = bothReady(t, a, b, "demo") // both reach callPhase = role-assigned

	// B leaves gracefully from role-assigned — in-call departure.
	b.send(leaveRoomMsg("demo"))

	// A observes peer_presence_changed(left, graceful_leave) AND
	// peer_left(graceful_leave). Order: presence first, then peer_left
	// (matches releaseAndNotify's emit order).
	_, rawPres := a.expect(proto.TypePeerPresenceChanged)
	pres := parsePayload[proto.PeerPresenceChangedPayload](t, rawPres)
	if pres.Presence != proto.PresenceLeft {
		t.Fatalf("presence=%q want left (in-call departure)", pres.Presence)
	}
	if pres.SubjectPeerID != peerB {
		t.Fatalf("subject=%s want %s", pres.SubjectPeerID, peerB)
	}

	_, rawLeft := a.expect(proto.TypePeerLeft)
	pl := parsePayload[proto.PeerLeftPayload](t, rawLeft)
	if pl.PeerID != peerB {
		t.Fatalf("peer_left.peerId=%s want %s", pl.PeerID, peerB)
	}
	if pl.Reason != proto.PeerLeftGracefulLeave {
		t.Fatalf("peer_left.reason=%q want graceful_leave", pl.Reason)
	}
}

// ---------------------------------------------------------------------
// Phase 12 — T086 server-side failure-path coverage
// ---------------------------------------------------------------------

// TestRoomFullRejectsWhilePending covers EC-003 for the pre-pairing
// case: a third peer attempting to join a room whose two slots are
// reserved but still pending-media MUST see join_rejected_room_full,
// and neither reserved peer observes any disruption (§3.3 + FR-002).
// Sibling of TestThirdJoinRejectedRoomFull (which uses already-ready
// peers); the pending-media variant locks down the room-full check
// running on slot reservation, not on media readiness.
func TestRoomFullRejectsWhilePending(t *testing.T) {
	ts := flowServer(t)

	a := dialClient(t, ts)
	a.joinAndAck("demo", newRequestID())

	b := dialClient(t, ts)
	b.joinAndAck("demo", newRequestID())
	// A sees B's admission event. Both slots now reserved; both peers
	// still pending-media (no media_ready sent).
	_, _ = a.expect(proto.TypePeerPresenceChanged)

	c := dialClient(t, ts)
	c.send(joinRoomMsg("demo", newRequestID()))

	_, raw := c.expect(proto.TypeJoinRejected)
	rej := parsePayload[proto.JoinRejectedPayload](t, raw)
	if rej.Result != proto.JoinRejectedRoomFull {
		t.Fatalf("third (pending-media) join result=%q, want join_rejected_room_full", rej.Result)
	}
	if rej.Reason != proto.ReasonRoomFull {
		t.Fatalf("reason=%q want room_full", rej.Reason)
	}

	// A and B MUST NOT observe any event as a result of C's rejected
	// join — no slot was reserved.
	a.expectNone(200 * time.Millisecond)
	b.expectNone(200 * time.Millisecond)
}

// TestWSPongTimeoutReleasesSlot covers SC-009 (≤ 10 s ungraceful-
// disconnect detection) at the protocol level with a paired, in-call
// sender. Uses a fast-heartbeat handler so the suite doesn't wait
// 10 s; production defaults (5 s + 5 s) stay untouched.
//
// The scenario: A and B both media-ready → paired → role-assigned.
// B stops reading (and therefore stops auto-ponging). The server
// Pongs time out → the WS is closed → deferred cleanup routes
// through classifyDeparture with reason="disconnect" and B's
// CallPhase = role-assigned (in-call) → A sees both
// peer_presence_changed(left, disconnect) AND peer_left(disconnect).
//
// Harness note: coder/websocket auto-replies to Pings only while a
// Read() is active. A needs a background reader to stay healthy
// while B idles. We run one for A and consume its frames via a
// channel; for B we simply never Read, which is enough to make
// B's pong window time out.
func TestWSPongTimeoutReleasesSlot(t *testing.T) {
	log, buf := captureLogger()
	t.Cleanup(func() {
		if t.Failed() {
			t.Logf("server log:\n%s", buf.String())
		}
	})
	h := sig.NewHandler(log)
	h.Heartbeat = sig.HeartbeatConfig{
		PingInterval: 50 * time.Millisecond,
		PongTimeout:  100 * time.Millisecond,
	}
	ts := httptest.NewServer(h)
	t.Cleanup(ts.Close)

	a := dialClient(t, ts)
	b := dialClient(t, ts)
	peerA, peerB := joinBoth(t, a, b, "demo")
	_ = peerA
	_, _ = bothReady(t, a, b, "demo") // both → callPhase role-assigned

	// Drain helper: read frames off A in a background goroutine so
	// the auto-pong stays alive. Forward each decoded frame into a
	// channel; test-thread asserts by consuming from the channel.
	type aFrame struct {
		env proto.Envelope
		raw json.RawMessage
	}
	aInbox := make(chan aFrame, 16)
	aReadErr := make(chan error, 1)
	go func() {
		for {
			_, raw, err := a.conn.Read(a.ctx)
			if err != nil {
				aReadErr <- err
				return
			}
			var env proto.Envelope
			if uerr := json.Unmarshal(raw, &env); uerr != nil {
				aReadErr <- uerr
				return
			}
			aInbox <- aFrame{env: env, raw: env.Payload}
		}
	}()

	expectOn := func(want proto.Type) aFrame {
		t.Helper()
		select {
		case f := <-aInbox:
			if f.env.Type != want {
				t.Fatalf("got type=%q want %q", f.env.Type, want)
			}
			return f
		case err := <-aReadErr:
			t.Fatalf("A read failed: %v", err)
		case <-time.After(2 * time.Second):
			t.Fatalf("timeout waiting for %q", want)
		}
		return aFrame{}
	}

	// B is already idle (no ongoing Read after bothReady returned).
	// The server's next Ping to B will get no Pong within 100 ms →
	// Close(PolicyViolation, "pong_timeout") → deferred cleanup →
	// releaseAndNotify(_, ccB, "disconnect").

	f := expectOn(proto.TypePeerPresenceChanged)
	pres := parsePayload[proto.PeerPresenceChangedPayload](t, f.raw)
	if pres.Presence != proto.PresenceLeft {
		t.Fatalf("presence=%q want left (in-call pong-timeout)", pres.Presence)
	}
	if pres.Reason != proto.PresenceReasonDisconnect {
		t.Fatalf("reason=%q want disconnect", pres.Reason)
	}
	if pres.SubjectPeerID != peerB {
		t.Fatalf("subject=%s want %s", pres.SubjectPeerID, peerB)
	}

	f = expectOn(proto.TypePeerLeft)
	pl := parsePayload[proto.PeerLeftPayload](t, f.raw)
	if pl.PeerID != peerB {
		t.Fatalf("peer_left.peerId=%s want %s", pl.PeerID, peerB)
	}
	if pl.Reason != proto.PeerLeftDisconnect {
		t.Fatalf("peer_left.reason=%q want disconnect", pl.Reason)
	}

	// The server should also log the pong_timeout reason line so
	// operators can distinguish clean WS-close from heartbeat failure.
	if !strings.Contains(buf.String(), "pong_timeout") {
		t.Errorf("expected pong_timeout log line; got:\n%s", buf.String())
	}
}

// TestLeaveDuringNegotiation covers EC-012: the offerer hangs up
// mid-handshake after sending its offer. The remaining peer MUST
// observe a clean graceful-leave (peer_presence_changed(left,
// graceful_leave) + peer_left(graceful_leave)) — B's callPhase
// advanced to `negotiating` on the offer relay, so the departure is
// still classified as in-call, not pre-pairing. No zombie
// RTCPeerConnection on B's side, no wedged slot on the server.
func TestLeaveDuringNegotiation(t *testing.T) {
	ts := flowServer(t)
	a := dialClient(t, ts)
	b := dialClient(t, ts)
	peerA, peerB := joinBoth(t, a, b, "demo")
	_, _ = bothReady(t, a, b, "demo") // both → role-assigned
	_ = peerA

	// A sends an offer; B receives it. A's callPhase advances
	// role-assigned → negotiating at the relay.
	a.send(offerMsg("demo", "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n"))
	_, _ = b.expect(proto.TypeOffer)

	// Now A hangs up without waiting for B's answer.
	a.send(leaveRoomMsg("demo"))

	// B observes peer_presence_changed(left, graceful_leave).
	_, rawPres := b.expect(proto.TypePeerPresenceChanged)
	pres := parsePayload[proto.PeerPresenceChangedPayload](t, rawPres)
	if pres.Presence != proto.PresenceLeft {
		t.Fatalf("presence=%q want left (leave-during-negotiation is in-call)", pres.Presence)
	}
	if pres.Reason != proto.PresenceReasonGracefulLeave {
		t.Fatalf("reason=%q want graceful_leave", pres.Reason)
	}
	if pres.SubjectPeerID != peerA {
		t.Fatalf("subject=%s want %s (the leaver)", pres.SubjectPeerID, peerA)
	}

	// … followed by peer_left(graceful_leave) — the convenience
	// cleanup trigger for Path B on the client side.
	_, rawLeft := b.expect(proto.TypePeerLeft)
	pl := parsePayload[proto.PeerLeftPayload](t, rawLeft)
	if pl.PeerID != peerA {
		t.Fatalf("peer_left.peerId=%s want %s", pl.PeerID, peerA)
	}
	if pl.Reason != proto.PeerLeftGracefulLeave {
		t.Fatalf("peer_left.reason=%q want graceful_leave", pl.Reason)
	}

	// Receiver-side invariant: B's next frame (if any) is not an
	// answer relay. The test does not drive B to send an answer, so
	// `expectNone` simply confirms no trailing protocol noise from
	// A's departure.
	_ = peerB
	b.expectNone(200 * time.Millisecond)
}

// TestInCallDisconnectEmitsPeerLeft — deferred from T028 per
// tasks.md; now reachable because Phase 4 wired media_ready + role
// assignment and Phase 12 factored the classifier into
// classifyDeparture. A paired, role-assigned peer ungracefully
// closes its WS; the remaining peer MUST observe both
// peer_presence_changed(left, disconnect) AND peer_left(disconnect).
// Complements TestInCallLeaveEmitsPeerLeft (the graceful-leave twin
// already in this file) so the in-call branch is covered for both
// departure reasons.
func TestInCallDisconnectEmitsPeerLeft(t *testing.T) {
	ts := flowServer(t)
	a := dialClient(t, ts)
	b := dialClient(t, ts)
	peerA, peerB := joinBoth(t, a, b, "demo")
	_, _ = bothReady(t, a, b, "demo") // both → role-assigned
	_ = peerA

	// B disconnects ungracefully from role-assigned. The server's
	// deferred cleanup runs classifyDeparture(reason="disconnect")
	// with B's CallPhase = role-assigned → in-call.
	_ = b.conn.Close(websocket.StatusAbnormalClosure, "test disconnect")

	_, rawPres := a.expect(proto.TypePeerPresenceChanged)
	pres := parsePayload[proto.PeerPresenceChangedPayload](t, rawPres)
	if pres.Presence != proto.PresenceLeft {
		t.Fatalf("presence=%q want left (in-call disconnect)", pres.Presence)
	}
	if pres.Reason != proto.PresenceReasonDisconnect {
		t.Fatalf("reason=%q want disconnect", pres.Reason)
	}
	if pres.SubjectPeerID != peerB {
		t.Fatalf("subject=%s want %s", pres.SubjectPeerID, peerB)
	}

	_, rawLeft := a.expect(proto.TypePeerLeft)
	pl := parsePayload[proto.PeerLeftPayload](t, rawLeft)
	if pl.PeerID != peerB {
		t.Fatalf("peer_left.peerId=%s want %s", pl.PeerID, peerB)
	}
	if pl.Reason != proto.PeerLeftDisconnect {
		t.Fatalf("peer_left.reason=%q want disconnect", pl.Reason)
	}
}
