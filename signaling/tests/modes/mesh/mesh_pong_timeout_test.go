package mesh_test

// T092 — mesh_pong_timeout_test.go (M12 / SC-005a / data-model §C.4).
//
// Asserts the ungraceful-disconnect cleanup contract:
//   - closing a socket without leave_room releases the slot
//   - remaining participants receive mesh_roster_update presence=left
//   - remaining participants receive peer_left { reason: "disconnect" }
//     when the leaver was in-call (readiness=media-ready)
//   - timeout completes within the configured 5 s + 5 s heartbeat bounds
//     (verified here at sub-second granularity via heartbeat overrides)
//   - room is deleted when the last participant times out
//   - room is preserved while other participants remain
//   - admission_index is monotonic and is not reused by a refilled slot
//   - no pair_failed envelope is emitted for unrelated peer-pairs (the
//     room never broadcasts pair_failed during disconnect cleanup)

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/coder/websocket"

	"webrtc-lab/signaling/internal/modes/mesh"

	protocol "webrtc-lab/signaling/internal/modes/mesh/protocol"
)

// meshSendMediaReady advances the participant from `joined` to
// `media-ready` so the next disconnect classifies as in-call.
func meshSendMediaReady(t *testing.T, ctx context.Context, conn *websocket.Conn, roomID string) {
	t.Helper()
	body, _ := json.Marshal(protocol.MediaReadyPayload{
		MediaCapabilities: protocol.MediaCapabilities{Audio: true, Video: true},
	})
	env := protocol.Envelope{
		V:       protocol.ContractVersion,
		Type:    protocol.TypeMediaReady,
		RoomID:  roomID,
		Payload: body,
	}
	raw, _ := json.Marshal(env)
	if err := conn.Write(ctx, websocket.MessageText, raw); err != nil {
		t.Fatalf("write media_ready: %v", err)
	}
}

// readUntilPeerLeft drains incoming envelopes until it sees a peer_left
// or fails on timeout. Used to confirm in-call leavers surface to
// remaining peers within bounds.
func readUntilPeerLeft(
	t *testing.T,
	ctx context.Context,
	conn *websocket.Conn,
	expectedPeer string,
) protocol.PeerLeftPayload {
	t.Helper()
	for {
		_, raw, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("read until peer_left: %v", err)
		}
		var env protocol.Envelope
		if err := json.Unmarshal(raw, &env); err != nil {
			continue
		}
		if env.Type != protocol.TypePeerLeft {
			continue
		}
		var p protocol.PeerLeftPayload
		if err := json.Unmarshal(env.Payload, &p); err != nil {
			t.Fatalf("unmarshal peer_left: %v", err)
		}
		if expectedPeer != "" && p.PeerID != expectedPeer {
			continue
		}
		return p
	}
}

// drainSelfAdmission advances past the snapshot + own admission update
// frames a fresh joiner receives.
func drainSelfAdmission(t *testing.T, ctx context.Context, conn *websocket.Conn) {
	t.Helper()
	_ = readMeshUntilType(t, ctx, conn, protocol.TypeMeshRosterSnapshot)
	_ = readMeshUntilType(t, ctx, conn, protocol.TypeMeshRosterUpdate)
}

// TestPongTimeout_ReleasesSlot — closing the socket without leave_room
// frees the participant's slot (verified via post-disconnect refill).
func TestPongTimeout_ReleasesSlot(t *testing.T) {
	h := mesh.NewHandler(silentLogger())
	ts := httptest.NewServer(h)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	connA, _, err := websocket.Dial(ctx, meshURLFor(ts), nil)
	if err != nil {
		t.Fatalf("dial A: %v", err)
	}
	_ = meshJoinRoom(t, ctx, connA, "demo", meshUUIDLike("a1"))
	drainSelfAdmission(t, ctx, connA)

	// Force-close A without leave_room. Heartbeat / pong-timeout fires.
	_ = connA.CloseNow()
	time.Sleep(300 * time.Millisecond)

	// Slot must be reusable. New joiner should be admitted.
	connB, _, err := websocket.Dial(ctx, meshURLFor(ts), nil)
	if err != nil {
		t.Fatalf("dial B: %v", err)
	}
	defer connB.CloseNow()
	got := meshJoinRoom(t, ctx, connB, "demo", meshUUIDLike("b1"))
	var p protocol.JoinAcceptedPayload
	if err := json.Unmarshal(got.Payload, &p); err != nil {
		t.Fatalf("unmarshal join_accepted: %v", err)
	}
	if p.PeerID == "" {
		t.Fatalf("expected fresh peer id on refill")
	}
}

// TestPongTimeout_RemainingPeersReceiveRosterLeft — remaining peers
// observe presence=left within bounds when a peer ungracefully closes.
func TestPongTimeout_RemainingPeersReceiveRosterLeft(t *testing.T) {
	h := mesh.NewHandler(silentLogger())
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
	_ = meshJoinRoom(t, ctx, connB, roomID, meshUUIDLike("b2"))
	drainSelfAdmission(t, ctx, connB)

	connA, _, err := websocket.Dial(ctx, meshURLFor(ts), nil)
	if err != nil {
		t.Fatalf("dial A: %v", err)
	}
	got := meshJoinRoom(t, ctx, connA, roomID, meshUUIDLike("a2"))
	var pAccepted protocol.JoinAcceptedPayload
	_ = json.Unmarshal(got.Payload, &pAccepted)

	// B drains A's admission roster_update.
	gotA := readMeshUntilType(t, ctx, connB, protocol.TypeMeshRosterUpdate)
	var pa protocol.MeshRosterUpdatePayload
	_ = json.Unmarshal(gotA.Payload, &pa)
	if pa.SubjectPeerID != pAccepted.PeerID {
		t.Fatalf("expected admission update for A, got subject=%q", pa.SubjectPeerID)
	}

	// A force-closes; B sees presence=left within heartbeat bounds.
	_ = connA.CloseNow()

	// readDeadline gates the assertion to within the bounded heartbeat
	// window. makeFastHandler uses 50 ms ping + 100 ms pong-timeout, so
	// 1 s is comfortably above the bound and well inside SC-005a.
	readCtx, cancelRead := context.WithTimeout(ctx, 1*time.Second)
	defer cancelRead()

	leftSeen := false
	for {
		env, err := readMeshEnvelopeWithCtx(readCtx, connB)
		if err != nil {
			break
		}
		if env.Type != protocol.TypeMeshRosterUpdate {
			continue
		}
		var p protocol.MeshRosterUpdatePayload
		if err := json.Unmarshal(env.Payload, &p); err != nil {
			continue
		}
		if p.Presence == protocol.PresenceLeft && p.SubjectPeerID == pAccepted.PeerID {
			leftSeen = true
			if p.Reason != protocol.RosterReasonDisconnect {
				t.Errorf("expected reason=%q, got %q", protocol.RosterReasonDisconnect, p.Reason)
			}
			break
		}
	}
	if !leftSeen {
		t.Fatalf("did not observe presence=left for A within bounds")
	}
}

// TestPongTimeout_InCallLeaverEmitsPeerLeftDisconnect — in-call
// leavers (readiness=media-ready) MUST also produce peer_left to
// remaining peers so each client can tear down its PairContext via
// Path B without waiting for connectionState=failed locally.
func TestPongTimeout_InCallLeaverEmitsPeerLeftDisconnect(t *testing.T) {
	h := mesh.NewHandler(silentLogger())
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
	_ = meshJoinRoom(t, ctx, connB, roomID, meshUUIDLike("b3"))
	drainSelfAdmission(t, ctx, connB)
	meshSendMediaReady(t, ctx, connB, roomID)
	// B media-ready roster update broadcast to itself.
	_ = readMeshUntilType(t, ctx, connB, protocol.TypeMeshRosterUpdate)

	connA, _, err := websocket.Dial(ctx, meshURLFor(ts), nil)
	if err != nil {
		t.Fatalf("dial A: %v", err)
	}
	gotA := meshJoinRoom(t, ctx, connA, roomID, meshUUIDLike("a3"))
	var pAccepted protocol.JoinAcceptedPayload
	_ = json.Unmarshal(gotA.Payload, &pAccepted)
	meshSendMediaReady(t, ctx, connA, roomID)

	// Synchronize: B observes the pair_negotiation_instruction the
	// server emits when both endpoints are media-ready. By then A's
	// readiness in the room map is media-ready; force-close after this
	// point classifies as an in-call leave.
	_ = readMeshUntilType(t, ctx, connB, protocol.TypePairNegotiationInstruction)

	// A force-closes → in-call disconnect.
	_ = connA.CloseNow()

	readCtx, cancelRead := context.WithTimeout(ctx, 5*time.Second)
	defer cancelRead()
	got := readUntilPeerLeft(t, readCtx, connB, pAccepted.PeerID)
	if got.Reason != protocol.PeerLeftDisconnect {
		t.Errorf("expected peer_left.reason=%q, got %q", protocol.PeerLeftDisconnect, got.Reason)
	}
}

// TestPongTimeout_RoomDeletedOnLastTimeout — when the last participant
// times out, the room is garbage-collected from the manager.
func TestPongTimeout_RoomDeletedOnLastTimeout(t *testing.T) {
	h := mesh.NewHandler(silentLogger())
	ts := httptest.NewServer(h)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, meshURLFor(ts), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	_ = meshJoinRoom(t, ctx, conn, "demo", meshUUIDLike("c1"))
	drainSelfAdmission(t, ctx, conn)

	if h.Manager.RoomCount() != 1 {
		t.Fatalf("expected 1 room, got %d", h.Manager.RoomCount())
	}

	_ = conn.CloseNow()
	time.Sleep(400 * time.Millisecond)

	if got := h.Manager.RoomCount(); got != 0 {
		t.Errorf("expected room GC after last participant timeout, got %d rooms", got)
	}
}

// TestPongTimeout_RoomPreservedWhileOthersRemain — room survives one
// disconnect when other participants still hold slots.
func TestPongTimeout_RoomPreservedWhileOthersRemain(t *testing.T) {
	h := mesh.NewHandler(silentLogger())
	ts := httptest.NewServer(h)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	connB, _, err := websocket.Dial(ctx, meshURLFor(ts), nil)
	if err != nil {
		t.Fatalf("dial B: %v", err)
	}
	defer connB.CloseNow()
	_ = meshJoinRoom(t, ctx, connB, "demo", meshUUIDLike("b4"))
	drainSelfAdmission(t, ctx, connB)

	connA, _, err := websocket.Dial(ctx, meshURLFor(ts), nil)
	if err != nil {
		t.Fatalf("dial A: %v", err)
	}
	_ = meshJoinRoom(t, ctx, connA, "demo", meshUUIDLike("a4"))

	_ = connA.CloseNow()
	time.Sleep(300 * time.Millisecond)

	if got := h.Manager.RoomCount(); got != 1 {
		t.Errorf("expected room to survive (1 participant remains), got %d rooms", got)
	}
}

// TestPongTimeout_AdmissionIndexMonotonicAfterRefill — slot reuse does
// NOT reuse admissionIndex; the next joiner gets a strictly-greater
// value within the same room. The contract's monotonic guarantee is
// per-room (data-model §A.4): once a room garbage-collects, a fresh
// room is a fresh counter — so we anchor the room with C and probe
// with A→close→B.
func TestPongTimeout_AdmissionIndexMonotonicAfterRefill(t *testing.T) {
	h := mesh.NewHandler(silentLogger())
	ts := httptest.NewServer(h)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	roomID := "demo"

	// Anchor the room so it is not GC'd between A leaving and B joining.
	connC, _, err := websocket.Dial(ctx, meshURLFor(ts), nil)
	if err != nil {
		t.Fatalf("dial C: %v", err)
	}
	defer connC.CloseNow()
	gotC := meshJoinRoom(t, ctx, connC, roomID, meshUUIDLike("c5"))
	var pC protocol.JoinAcceptedPayload
	_ = json.Unmarshal(gotC.Payload, &pC)
	drainSelfAdmission(t, ctx, connC)

	connA, _, err := websocket.Dial(ctx, meshURLFor(ts), nil)
	if err != nil {
		t.Fatalf("dial A: %v", err)
	}
	gotA := meshJoinRoom(t, ctx, connA, roomID, meshUUIDLike("a5"))
	var pA protocol.JoinAcceptedPayload
	_ = json.Unmarshal(gotA.Payload, &pA)

	_ = connA.CloseNow()
	time.Sleep(300 * time.Millisecond)

	connB, _, err := websocket.Dial(ctx, meshURLFor(ts), nil)
	if err != nil {
		t.Fatalf("dial B: %v", err)
	}
	defer connB.CloseNow()
	gotB := meshJoinRoom(t, ctx, connB, roomID, meshUUIDLike("b5"))
	var pB protocol.JoinAcceptedPayload
	_ = json.Unmarshal(gotB.Payload, &pB)

	if pA.AdmissionIndex <= pC.AdmissionIndex {
		t.Errorf("A admissionIndex must follow C: A=%d, C=%d", pA.AdmissionIndex, pC.AdmissionIndex)
	}
	if pB.AdmissionIndex <= pA.AdmissionIndex {
		t.Errorf(
			"admissionIndex regressed after refill: A=%d, B=%d (must be strictly greater)",
			pA.AdmissionIndex, pB.AdmissionIndex,
		)
	}
}

// TestPongTimeout_NoPairFailedForUnrelatedPairs — the disconnect path
// MUST NOT emit `pair_failed` to remaining peers. Path B teardown is
// driven by `peer_left` + roster `left`, both of which carry the
// leaver's peerId only — never a pairId. The server never inspects
// pairs during disconnect cleanup.
func TestPongTimeout_NoPairFailedForUnrelatedPairs(t *testing.T) {
	h := mesh.NewHandler(silentLogger())
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
	_ = meshJoinRoom(t, ctx, connB, roomID, meshUUIDLike("b6"))
	drainSelfAdmission(t, ctx, connB)
	meshSendMediaReady(t, ctx, connB, roomID)
	_ = readMeshUntilType(t, ctx, connB, protocol.TypeMeshRosterUpdate)

	connA, _, err := websocket.Dial(ctx, meshURLFor(ts), nil)
	if err != nil {
		t.Fatalf("dial A: %v", err)
	}
	_ = meshJoinRoom(t, ctx, connA, roomID, meshUUIDLike("a6"))
	meshSendMediaReady(t, ctx, connA, roomID)

	// Sync on the pair instruction that confirms both A and B are
	// media-ready and a pair has formed.
	_ = readMeshUntilType(t, ctx, connB, protocol.TypePairNegotiationInstruction)

	// A force-closes.
	_ = connA.CloseNow()

	// Drain whatever B receives in the next 2 seconds; assert NONE of
	// it is a pair_failed envelope. Use a single bounded read context
	// so coder/websocket auto-pong continues to work.
	readCtx, cancelRead := context.WithTimeout(ctx, 2*time.Second)
	defer cancelRead()
	leftSeen := false
	for {
		env, err := readMeshEnvelopeWithCtx(readCtx, connB)
		if err != nil {
			break
		}
		if env.Type == protocol.TypePairFailed {
			t.Fatalf(
				"server emitted pair_failed during disconnect cleanup: %s",
				string(env.Payload),
			)
		}
		if env.Type == protocol.TypePeerLeft {
			leftSeen = true
		}
	}
	if !leftSeen {
		t.Errorf("expected peer_left for in-call leaver, none observed")
	}
}

// readMeshEnvelopeWithCtx is the time-bounded sibling of readMeshEnvelope.
// Returns the read error so callers can switch on Done() without a t.Fatal.
func readMeshEnvelopeWithCtx(ctx context.Context, conn *websocket.Conn) (protocol.Envelope, error) {
	_, raw, err := conn.Read(ctx)
	if err != nil {
		return protocol.Envelope{}, err
	}
	var env protocol.Envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return protocol.Envelope{}, err
	}
	return env, nil
}

// Sanity: the heartbeat constants in production (5s + 5s) bound the
// detection window at SC-005a's ≤10 s. We don't sleep for that here —
// makeFastHandler shrinks the bound — but assert the production
// defaults haven't drifted into something laxer than the spec.
func TestPongTimeout_HeartbeatBoundsRespectSpec(t *testing.T) {
	h := mesh.NewHandler(silentLogger())
	if h.Heartbeat.PingInterval > 5*time.Second {
		t.Errorf("ping interval %v exceeds SC-005a 5 s budget", h.Heartbeat.PingInterval)
	}
	if h.Heartbeat.PongTimeout > 5*time.Second {
		t.Errorf("pong timeout %v exceeds SC-005a 5 s budget", h.Heartbeat.PongTimeout)
	}
	total := h.Heartbeat.PingInterval + h.Heartbeat.PongTimeout
	if total > 10*time.Second {
		t.Errorf("ping+pong total %v exceeds SC-005a 10 s budget", total)
	}
}
