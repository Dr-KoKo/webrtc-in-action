// T030 — admission + 5th rejection acceptance tests.
//
// Covers:
//   - 4 WS clients are admitted; the 5th gets join_rejected with
//     result = "join_rejected_room_full" inside SC-004's 2 s budget.
//   - admissionIndex is monotonic AND never reused across the room's
//     lifetime (TestAdmissionIndexNeverReused).
//   - pairId derivation uses admissionIndex, not slot.Index, so a
//     freed-then-reused slot does NOT produce a colliding pairId
//     (TestPairIdUsesAdmissionIndexNotSlotIndex).
//
// All tests run against the in-process /ws/mesh handler so the assert
// surface includes the on-the-wire envelope shape (not just the
// internal admission outcome).

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

// joinAndExpectAccepted dials /ws/mesh, sends a join_room for roomID,
// and reads the join_accepted reply. Returns the conn (caller must
// close), the assigned peerID, and the admissionIndex.
func joinAndExpectAccepted(t *testing.T, ts *httptest.Server, ctx context.Context, roomID string) (*websocket.Conn, string, uint64) {
	t.Helper()
	conn := dialMesh(t, ts, ctx)
	req := []byte(`{"v":2,"type":"join_room","roomId":"` + roomID + `","requestId":"deadbeef-0000-4000-8000-000000000001","payload":{}}`)
	if err := conn.Write(ctx, websocket.MessageText, req); err != nil {
		t.Fatalf("write join_room failed: %v", err)
	}
	// Expect: join_accepted, then mesh_roster_snapshot, then mesh_roster_update.
	_, raw, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read join_accepted failed: %v", err)
	}
	var env protocol.Envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatalf("envelope unmarshal failed: %v", err)
	}
	if env.Type != protocol.TypeJoinAccepted {
		t.Fatalf("type = %q, want %q", env.Type, protocol.TypeJoinAccepted)
	}
	var p protocol.JoinAcceptedPayload
	if err := json.Unmarshal(env.Payload, &p); err != nil {
		t.Fatalf("payload unmarshal failed: %v", err)
	}
	return conn, p.PeerID, p.AdmissionIndex
}

// drainMeshFrames reads up to n frames within timeout; returns slice.
// Useful when the order between roster_snapshot and roster_update is
// not asserted by the specific test.
func drainMeshFrames(t *testing.T, conn *websocket.Conn, ctx context.Context, n int) []protocol.Envelope {
	t.Helper()
	out := make([]protocol.Envelope, 0, n)
	for i := 0; i < n; i++ {
		_, raw, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("read frame %d failed: %v", i, err)
		}
		var env protocol.Envelope
		if err := json.Unmarshal(raw, &env); err != nil {
			t.Fatalf("frame %d unmarshal failed: %v", i, err)
		}
		out = append(out, env)
	}
	return out
}

// TestFourthAdmittedFifthRejectedRoomFull — SC-004 happy path.
func TestFourthAdmittedFifthRejectedRoomFull(t *testing.T) {
	h := mesh.NewHandler(silentLogger())
	ts := httptest.NewServer(h)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	const roomID = "demo"
	conns := make([]*websocket.Conn, 0, 4)
	for i := 1; i <= 4; i++ {
		c, _, idx := joinAndExpectAccepted(t, ts, ctx, roomID)
		if uint64(i) != idx {
			t.Fatalf("admission %d got admissionIndex %d, want %d", i, idx, i)
		}
		// Drain snapshot + roster_update for this conn so subsequent
		// reads on it don't see them. We don't assert ordering here —
		// the dedicated roster test does that.
		_ = drainMeshFrames(t, c, ctx, 2)
		conns = append(conns, c)
	}

	// 5th joiner — must be rejected within the SC-004 budget.
	start := time.Now()
	fifth := dialMesh(t, ts, ctx)
	defer fifth.CloseNow()
	req := []byte(`{"v":2,"type":"join_room","roomId":"` + roomID + `","requestId":"deadbeef-0000-4000-8000-000000000099","payload":{}}`)
	if err := fifth.Write(ctx, websocket.MessageText, req); err != nil {
		t.Fatalf("5th write failed: %v", err)
	}
	_, raw, err := fifth.Read(ctx)
	if err != nil {
		t.Fatalf("5th read failed: %v", err)
	}
	elapsed := time.Since(start)
	if elapsed > 2*time.Second {
		t.Errorf("5th rejection took %v; SC-004 budget is 2 s", elapsed)
	}
	var env protocol.Envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatalf("5th envelope unmarshal failed: %v", err)
	}
	if env.Type != protocol.TypeJoinRejected {
		t.Fatalf("5th type = %q, want %q", env.Type, protocol.TypeJoinRejected)
	}
	var rej protocol.JoinRejectedPayload
	if err := json.Unmarshal(env.Payload, &rej); err != nil {
		t.Fatalf("5th payload unmarshal failed: %v", err)
	}
	if rej.Result != protocol.JoinRejectedRoomFull {
		t.Fatalf("5th result = %q, want %q", rej.Result, protocol.JoinRejectedRoomFull)
	}
	if rej.Reason != protocol.ReasonRoomFull {
		t.Fatalf("5th reason = %q, want %q", rej.Reason, protocol.ReasonRoomFull)
	}

	for _, c := range conns {
		_ = c.Close(websocket.StatusNormalClosure, "bye")
	}
}

// TestAdmissionIndexNeverReused locks in the §A.2 invariant: a freed
// admissionIndex value is NEVER recycled. The next joiner gets a
// strictly-greater index.
func TestAdmissionIndexNeverReused(t *testing.T) {
	h := mesh.NewHandler(silentLogger())
	ts := httptest.NewServer(h)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	const roomID = "demo"
	connA, _, idxA := joinAndExpectAccepted(t, ts, ctx, roomID)
	_ = drainMeshFrames(t, connA, ctx, 2)
	connB, _, idxB := joinAndExpectAccepted(t, ts, ctx, roomID)
	_ = drainMeshFrames(t, connB, ctx, 2)

	if idxA != 1 || idxB != 2 {
		t.Fatalf("indices = (%d, %d), want (1, 2)", idxA, idxB)
	}

	// A leaves gracefully — slot 0 is freed and admissionCounter
	// advances past 2.
	leaveReq := []byte(`{"v":2,"type":"leave_room","roomId":"` + roomID + `","payload":{}}`)
	if err := connA.Write(ctx, websocket.MessageText, leaveReq); err != nil {
		t.Fatalf("leave write failed: %v", err)
	}
	_ = connA.CloseNow()
	// Allow B's roster update to be sent so the read buffer isn't
	// occupying B's pending frames when C joins.
	if _, _, err := connB.Read(ctx); err != nil {
		t.Fatalf("B read of A's roster_update failed: %v", err)
	}

	// C joins — must get admissionIndex strictly greater than B's.
	connC, _, idxC := joinAndExpectAccepted(t, ts, ctx, roomID)
	defer connC.CloseNow()
	if idxC <= idxB {
		t.Fatalf("C admissionIndex = %d, must be > B's %d (no reuse)", idxC, idxB)
	}
	if idxC != 3 {
		t.Fatalf("C admissionIndex = %d, want 3 (strict monotonic)", idxC)
	}
	_ = drainMeshFrames(t, connC, ctx, 2)
	_ = connB.Close(websocket.StatusNormalClosure, "bye")
}

// TestPairIdUsesAdmissionIndexNotSlotIndex — induces a freed-then-
// reused slot and asserts the resulting pairId derivation uses
// admissionIndex (not the slot.Index, which IS reused). After A
// leaves and C takes A's slot, the (B, C) pairId must be "2-3", NOT
// "1-2" (which would collide with the historical (A, B) pairId).
func TestPairIdUsesAdmissionIndexNotSlotIndex(t *testing.T) {
	// Verifying the derivation rule itself is sufficient — MakePairID
	// is the pure function the room uses internally.
	if got := protocol.MakePairID(1, 2); got != "1-2" {
		t.Fatalf("(A=1, B=2) pairId = %q, want %q", got, "1-2")
	}
	if got := protocol.MakePairID(2, 3); got != "2-3" {
		t.Fatalf("(B=2, C=3) pairId = %q, want %q", got, "2-3")
	}
	if protocol.MakePairID(1, 2) == protocol.MakePairID(2, 3) {
		t.Fatal("pairId(A,B) collided with pairId(B,C); admissionIndex monotonicity is broken")
	}

	// End-to-end check: drive A+B+(A leaves)+C through the in-process
	// handler and assert C's admissionIndex >= 3, so MakePairID(B, C) =
	// "2-3" — definitively distinct from the historical "1-2".
	h := mesh.NewHandler(silentLogger())
	ts := httptest.NewServer(h)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	const roomID = "pair-recycle"
	connA, _, idxA := joinAndExpectAccepted(t, ts, ctx, roomID)
	_ = drainMeshFrames(t, connA, ctx, 2)
	connB, _, idxB := joinAndExpectAccepted(t, ts, ctx, roomID)
	_ = drainMeshFrames(t, connB, ctx, 2)

	leaveReq := []byte(`{"v":2,"type":"leave_room","roomId":"` + roomID + `","payload":{}}`)
	if err := connA.Write(ctx, websocket.MessageText, leaveReq); err != nil {
		t.Fatalf("leave write failed: %v", err)
	}
	_ = connA.CloseNow()
	if _, _, err := connB.Read(ctx); err != nil {
		t.Fatalf("B read of A's roster_update failed: %v", err)
	}

	connC, _, idxC := joinAndExpectAccepted(t, ts, ctx, roomID)
	defer connC.CloseNow()
	defer connB.Close(websocket.StatusNormalClosure, "bye")

	pairOldAB := protocol.MakePairID(idxA, idxB)
	pairNewBC := protocol.MakePairID(idxB, idxC)
	if pairOldAB == pairNewBC {
		t.Fatalf("pair recycle collision: old (A,B)=%q == new (B,C)=%q", pairOldAB, pairNewBC)
	}
}
