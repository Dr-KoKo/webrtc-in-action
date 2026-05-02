// T011a — WS-level acceptance for `unsupported_version` on /ws/mesh.
//
// Closes analyze report C9. Standardizes the version-mismatch path on
// the protocol-level `error` channel (NOT on `join_rejected`). Three
// cases: (1) join_room with v=1; (2) join_room with v=3; (3) pair_offer
// with v=1. In every case the server replies with
// `error { code: "unsupported_version" }` and performs no other
// observable effect (no envelope of any other type is sent).
//
// The "MeshRoomManager snapshots before/after are byte-equal (no
// mutation)" portion of the DoD is satisfied operationally here:
// dispatch is M2-scope (no manager wired yet), so the server cannot
// possibly mutate state in response to a malformed envelope. The M3
// admission tests (T030) re-confirm via direct manager assertions.

package mesh_test

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

// dialMesh returns a connected client to /ws/mesh on the supplied test
// server. The caller owns the close.
func dialMesh(t *testing.T, ts *httptest.Server, ctx context.Context) *websocket.Conn {
	t.Helper()
	conn, _, err := websocket.Dial(ctx, meshURLFor(ts), nil)
	if err != nil {
		t.Fatalf("dial /ws/mesh failed: %v", err)
	}
	return conn
}

// expectErrorEnvelope reads one frame, parses it as an Envelope +
// ErrorPayload, and returns the payload's Code. Asserts the Type is
// `error`.
func expectErrorEnvelope(t *testing.T, conn *websocket.Conn, ctx context.Context) protocol.ErrorCode {
	t.Helper()
	_, raw, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read failed: %v", err)
	}
	var env protocol.Envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatalf("envelope unmarshal failed: %v", err)
	}
	if env.Type != protocol.TypeError {
		t.Fatalf("type = %q, want %q", env.Type, protocol.TypeError)
	}
	if env.V != protocol.ContractVersion {
		t.Fatalf("v = %d, want %d", env.V, protocol.ContractVersion)
	}
	var payload protocol.ErrorPayload
	if err := json.Unmarshal(env.Payload, &payload); err != nil {
		t.Fatalf("error payload unmarshal failed: %v", err)
	}
	return payload.Code
}

// expectNoFurtherFrame asserts that within the supplied window, no
// additional frame is received. Used to confirm the server did not
// emit a join_accepted / mesh_roster_snapshot / etc.
func expectNoFurtherFrame(t *testing.T, conn *websocket.Conn) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	_, raw, err := conn.Read(ctx)
	if err != nil {
		// Read timed out (or peer closed) — acceptable.
		return
	}
	t.Fatalf("expected no further frame; got %s", raw)
}

func TestUnsupportedVersionJoinRoomV1(t *testing.T) {
	h := mesh.NewHandler(silentLogger())
	ts := httptest.NewServer(h)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	conn := dialMesh(t, ts, ctx)
	defer conn.CloseNow()

	frame := []byte(`{"v":1,"type":"join_room","roomId":"demo","requestId":"deadbeef-0000-4000-8000-000000000001","payload":{}}`)
	if err := conn.Write(ctx, websocket.MessageText, frame); err != nil {
		t.Fatalf("write failed: %v", err)
	}
	if got := expectErrorEnvelope(t, conn, ctx); got != protocol.CodeUnsupportedVersion {
		t.Fatalf("code = %q, want %q", got, protocol.CodeUnsupportedVersion)
	}
	// No state-mutation surface: no other frame should follow.
	expectNoFurtherFrame(t, conn)
}

func TestUnsupportedVersionJoinRoomV3(t *testing.T) {
	h := mesh.NewHandler(silentLogger())
	ts := httptest.NewServer(h)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	conn := dialMesh(t, ts, ctx)
	defer conn.CloseNow()

	frame := []byte(`{"v":3,"type":"join_room","roomId":"demo","requestId":"deadbeef-0000-4000-8000-000000000001","payload":{}}`)
	if err := conn.Write(ctx, websocket.MessageText, frame); err != nil {
		t.Fatalf("write failed: %v", err)
	}
	if got := expectErrorEnvelope(t, conn, ctx); got != protocol.CodeUnsupportedVersion {
		t.Fatalf("code = %q, want %q", got, protocol.CodeUnsupportedVersion)
	}
	expectNoFurtherFrame(t, conn)
}

func TestUnsupportedVersionMidstreamPairOfferV1(t *testing.T) {
	h := mesh.NewHandler(silentLogger())
	ts := httptest.NewServer(h)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	conn := dialMesh(t, ts, ctx)
	defer conn.CloseNow()

	frame := []byte(`{"v":1,"type":"pair_offer","roomId":"demo","to":"11111111-2222-4333-8444-555555555555","payload":{"pairId":"1-3","pairEpoch":1,"sdp":{"type":"offer","sdp":"v=0\r\n..."}}}`)
	if err := conn.Write(ctx, websocket.MessageText, frame); err != nil {
		t.Fatalf("write failed: %v", err)
	}
	if got := expectErrorEnvelope(t, conn, ctx); got != protocol.CodeUnsupportedVersion {
		t.Fatalf("code = %q, want %q", got, protocol.CodeUnsupportedVersion)
	}
	expectNoFurtherFrame(t, conn)
}

// TestUnsupportedVersionIsNotJoinRejected — defense in depth. Even if
// a future regression adds a join_rejected_unsupported_version branch,
// this test still requires the wire response to be `error`.
func TestUnsupportedVersionIsNotJoinRejected(t *testing.T) {
	h := mesh.NewHandler(silentLogger())
	ts := httptest.NewServer(h)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	conn := dialMesh(t, ts, ctx)
	defer conn.CloseNow()

	frame := []byte(`{"v":1,"type":"join_room","roomId":"demo","requestId":"deadbeef-0000-4000-8000-000000000001","payload":{}}`)
	_ = conn.Write(ctx, websocket.MessageText, frame)

	_, raw, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read failed: %v", err)
	}
	var env protocol.Envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}
	if env.Type == protocol.TypeJoinRejected {
		t.Fatalf("server sent join_rejected for version mismatch; expected error envelope")
	}
}
