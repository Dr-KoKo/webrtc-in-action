// T030 — roster snapshot + strictly-increasing serverSeq across 6+
// updates. Asserts §A.6 monotonicity invariant.

package mesh_test

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/coder/websocket"

	"webrtc-lab/signaling/internal/modes/mesh"
)

// readUntilType drains frames from conn until one of the requested
// types arrives. Returns that frame. Other frames are discarded.
// Caller-provided ctx bounds the wait.
func readUntilType(t *testing.T, conn *websocket.Conn, ctx context.Context, want mesh.MessageType) mesh.Envelope {
	t.Helper()
	for {
		_, raw, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("read failed waiting for %q: %v", want, err)
		}
		var env mesh.Envelope
		if err := json.Unmarshal(raw, &env); err != nil {
			t.Fatalf("unmarshal failed: %v", err)
		}
		if env.Type == want {
			return env
		}
	}
}

func TestSnapshotIncludesAllParticipantsIncludingSelf(t *testing.T) {
	h := mesh.NewHandler(silentLogger())
	ts := httptest.NewServer(h)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	const roomID = "snap-room"
	connA, peerA, _ := joinAndExpectAccepted(t, ts, ctx, roomID)
	defer connA.CloseNow()
	snapA := readUntilType(t, connA, ctx, mesh.TypeMeshRosterSnapshot)
	var snapPayloadA mesh.MeshRosterSnapshotPayload
	if err := json.Unmarshal(snapA.Payload, &snapPayloadA); err != nil {
		t.Fatalf("snapshot unmarshal failed: %v", err)
	}
	if len(snapPayloadA.Participants) != 1 || snapPayloadA.Participants[0].PeerID != peerA {
		t.Fatalf("first snapshot participants = %+v; want exactly self %q", snapPayloadA.Participants, peerA)
	}

	// Drain A's own roster_update presence:joined so subsequent reads
	// see B's broadcasts cleanly.
	_ = readUntilType(t, connA, ctx, mesh.TypeMeshRosterUpdate)

	connB, peerB, _ := joinAndExpectAccepted(t, ts, ctx, roomID)
	defer connB.CloseNow()
	snapB := readUntilType(t, connB, ctx, mesh.TypeMeshRosterSnapshot)
	var snapPayloadB mesh.MeshRosterSnapshotPayload
	if err := json.Unmarshal(snapB.Payload, &snapPayloadB); err != nil {
		t.Fatalf("B snapshot unmarshal failed: %v", err)
	}
	if len(snapPayloadB.Participants) != 2 {
		t.Fatalf("B snapshot has %d participants, want 2", len(snapPayloadB.Participants))
	}
	seen := map[string]bool{}
	for _, p := range snapPayloadB.Participants {
		seen[p.PeerID] = true
	}
	if !seen[peerA] || !seen[peerB] {
		t.Fatalf("B snapshot missing %q or %q: %+v", peerA, peerB, snapPayloadB.Participants)
	}
}

// TestRosterSeqStrictlyIncreasing — induces 6 roster broadcasts and
// asserts the serverSeq values are strictly monotonic on the receiving
// peer (which receives EVERY update including its own admission).
func TestRosterSeqStrictlyIncreasing(t *testing.T) {
	h := mesh.NewHandler(silentLogger())
	ts := httptest.NewServer(h)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	const roomID = "seq-room"

	// A joins; A receives one roster_update (its own admission, seq=1).
	connA, _, _ := joinAndExpectAccepted(t, ts, ctx, roomID)
	defer connA.CloseNow()
	readUntilType(t, connA, ctx, mesh.TypeMeshRosterSnapshot)
	seq1 := mustReadSeq(t, connA, ctx)

	// B, C, D join — each fires one update broadcast for itself, A
	// receives 3 more updates → seq 2, 3, 4.
	connB, _, _ := joinAndExpectAccepted(t, ts, ctx, roomID)
	defer connB.CloseNow()
	readUntilType(t, connB, ctx, mesh.TypeMeshRosterSnapshot)
	seq2 := mustReadSeq(t, connA, ctx)
	_ = mustReadSeq(t, connB, ctx) // B receives its own joined update

	connC, _, _ := joinAndExpectAccepted(t, ts, ctx, roomID)
	defer connC.CloseNow()
	readUntilType(t, connC, ctx, mesh.TypeMeshRosterSnapshot)
	seq3 := mustReadSeq(t, connA, ctx)
	_ = mustReadSeq(t, connB, ctx)
	_ = mustReadSeq(t, connC, ctx)

	connD, _, _ := joinAndExpectAccepted(t, ts, ctx, roomID)
	defer connD.CloseNow()
	readUntilType(t, connD, ctx, mesh.TypeMeshRosterSnapshot)
	seq4 := mustReadSeq(t, connA, ctx)
	_ = mustReadSeq(t, connB, ctx)
	_ = mustReadSeq(t, connC, ctx)
	_ = mustReadSeq(t, connD, ctx)

	// B leaves — A, C, D each get a roster_update presence:left, seq=5.
	leaveReq := []byte(`{"v":2,"type":"leave_room","roomId":"` + roomID + `","payload":{}}`)
	if err := connB.Write(ctx, websocket.MessageText, leaveReq); err != nil {
		t.Fatalf("B leave write failed: %v", err)
	}
	seq5 := mustReadSeq(t, connA, ctx)
	_ = mustReadSeq(t, connC, ctx)
	_ = mustReadSeq(t, connD, ctx)

	// C leaves — A, D each get a roster_update presence:left, seq=6.
	if err := connC.Write(ctx, websocket.MessageText, leaveReq); err != nil {
		t.Fatalf("C leave write failed: %v", err)
	}
	seq6 := mustReadSeq(t, connA, ctx)
	_ = mustReadSeq(t, connD, ctx)

	got := []uint64{seq1, seq2, seq3, seq4, seq5, seq6}
	for i := 1; i < len(got); i++ {
		if got[i] <= got[i-1] {
			t.Fatalf("serverSeq not strictly increasing: %v", got)
		}
	}
}

// mustReadSeq reads one mesh_roster_update and returns its serverSeq.
// Drains intermediate frames (none expected in M3 but safe-guarded).
func mustReadSeq(t *testing.T, conn *websocket.Conn, ctx context.Context) uint64 {
	t.Helper()
	upd := readUntilType(t, conn, ctx, mesh.TypeMeshRosterUpdate)
	var p mesh.MeshRosterUpdatePayload
	if err := json.Unmarshal(upd.Payload, &p); err != nil {
		t.Fatalf("update unmarshal failed: %v", err)
	}
	return p.ServerSeq
}

// TestSameDepartureSharesOneServerSeq — a single departure broadcast
// MUST carry one serverSeq across every recipient. Regression guard
// caught by the meshprobe runner: an earlier impl re-built the
// roster_update payload per recipient, bumping serverSeq each time.
func TestSameDepartureSharesOneServerSeq(t *testing.T) {
	h := mesh.NewHandler(silentLogger())
	ts := httptest.NewServer(h)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	const roomID = "departure-seq"
	connA, _, _ := joinAndExpectAccepted(t, ts, ctx, roomID)
	defer connA.CloseNow()
	readUntilType(t, connA, ctx, mesh.TypeMeshRosterSnapshot)
	_ = mustReadSeq(t, connA, ctx) // own admission

	connB, _, _ := joinAndExpectAccepted(t, ts, ctx, roomID)
	defer connB.CloseNow()
	readUntilType(t, connB, ctx, mesh.TypeMeshRosterSnapshot)
	_ = mustReadSeq(t, connA, ctx) // B's admission seen by A
	_ = mustReadSeq(t, connB, ctx) // B's own admission

	connC, _, _ := joinAndExpectAccepted(t, ts, ctx, roomID)
	defer connC.CloseNow()
	readUntilType(t, connC, ctx, mesh.TypeMeshRosterSnapshot)
	_ = mustReadSeq(t, connA, ctx) // C's admission seen by A
	_ = mustReadSeq(t, connB, ctx) // seen by B
	_ = mustReadSeq(t, connC, ctx) // own

	// B leaves — A and C must see the SAME serverSeq for this event.
	leaveReq := []byte(`{"v":2,"type":"leave_room","roomId":"` + roomID + `","payload":{}}`)
	if err := connB.Write(ctx, websocket.MessageText, leaveReq); err != nil {
		t.Fatalf("B leave write failed: %v", err)
	}
	seqA := mustReadSeq(t, connA, ctx)
	seqC := mustReadSeq(t, connC, ctx)
	if seqA != seqC {
		t.Fatalf("same departure delivered with different serverSeq: A=%d C=%d", seqA, seqC)
	}
}

// TestEmptyRoomGarbageCollected — the manager removes a room from its
// registry once the last participant leaves. Diagnostic only; the
// invariant matters for memory hygiene over long sessions.
func TestEmptyRoomGarbageCollected(t *testing.T) {
	h := mesh.NewHandler(silentLogger())
	ts := httptest.NewServer(h)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	connA, _, _ := joinAndExpectAccepted(t, ts, ctx, "gc-room")
	if h.Manager.RoomCount() != 1 {
		t.Fatalf("room count = %d after first join, want 1", h.Manager.RoomCount())
	}
	leaveReq := []byte(`{"v":2,"type":"leave_room","roomId":"gc-room","payload":{}}`)
	_ = connA.Write(ctx, websocket.MessageText, leaveReq)
	_ = connA.CloseNow()

	// Allow the deferred ServeHTTP cleanup to run.
	deadline := time.Now().Add(2 * time.Second)
	for h.Manager.RoomCount() != 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if h.Manager.RoomCount() != 0 {
		t.Fatalf("expected empty registry after last leave; got %d rooms", h.Manager.RoomCount())
	}
}

// TestSnapshotServerSeqStrictlyGreaterThanPriorEmissions — §3.4
// conformance hardening (B-1). The snapshot's ServerSeq must be
// > 0 after the first admission AND the next mesh_roster_update
// must be > snapshot.ServerSeq. Together these guarantee the
// emitted seq is unambiguous regardless of whether the snapshot is
// treated as a "fresh emission" or a "re-emission of the most
// recent value."
func TestSnapshotServerSeqStrictlyGreaterThanPriorEmissions(t *testing.T) {
	h := mesh.NewHandler(silentLogger())
	ts := httptest.NewServer(h)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	const roomID = "snapshot-seq"

	// Admit A. Read join_accepted, snapshot, then A's own joined-update.
	connA, _, _ := joinAndExpectAccepted(t, ts, ctx, roomID)
	defer connA.CloseNow()
	snap := readUntilType(t, connA, ctx, mesh.TypeMeshRosterSnapshot)
	var snapPayload mesh.MeshRosterSnapshotPayload
	if err := json.Unmarshal(snap.Payload, &snapPayload); err != nil {
		t.Fatalf("snapshot unmarshal failed: %v", err)
	}
	if snapPayload.ServerSeq == 0 {
		t.Fatalf("snapshot.ServerSeq = 0; want > 0 (snapshot must bump rosterSeq for §3.4 conformance)")
	}

	// First mesh_roster_update for A's own admission must be strictly
	// greater than the snapshot's seq.
	upd := readUntilType(t, connA, ctx, mesh.TypeMeshRosterUpdate)
	var updPayload mesh.MeshRosterUpdatePayload
	if err := json.Unmarshal(upd.Payload, &updPayload); err != nil {
		t.Fatalf("update unmarshal failed: %v", err)
	}
	if updPayload.ServerSeq <= snapPayload.ServerSeq {
		t.Fatalf("update.ServerSeq = %d, want > snapshot.ServerSeq = %d",
			updPayload.ServerSeq, snapPayload.ServerSeq)
	}
}
