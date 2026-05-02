// T052 — pair eligibility evaluator integration tests (contract §3.9,
// FR-022 + FR-022a). Drives the in-process /ws/mesh handler through
// admit + media-ready transitions and asserts the server emits
// `pair_negotiation_instruction` envelopes for NEW pairs only, with
// the correct (offerer, answerer) role assignment per admissionIndex.
//
// L18 / FR-022a — when the 4th participant becomes media-ready in an
// A/B/C room, exactly 3 new pairIds are minted and exactly 6 unicast
// instruction envelopes are emitted (one per endpoint of each new
// pair). No instructions are delivered for the pre-existing pairs
// A↔B, A↔C, B↔C.

package mesh_test

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"sort"
	"testing"
	"time"

	"github.com/coder/websocket"

	"webrtc-lab/signaling/internal/modes/mesh"

	protocol "webrtc-lab/signaling/internal/modes/mesh/protocol"
)

// readNPairInstructions reads exactly n frames from conn, each of
// which MUST be `pair_negotiation_instruction`. The coder/websocket
// library treats context cancellation as a fatal close, so this
// helper avoids timeout-based draining — callers must know the
// expected count.
func readNPairInstructions(t *testing.T, conn *websocket.Conn, ctx context.Context, n int) []protocol.PairNegotiationInstructionPayload {
	t.Helper()
	out := make([]protocol.PairNegotiationInstructionPayload, 0, n)
	for i := 0; i < n; i++ {
		_, raw, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("read instruction %d/%d failed: %v", i+1, n, err)
		}
		var env protocol.Envelope
		if err := json.Unmarshal(raw, &env); err != nil {
			t.Fatalf("envelope unmarshal: %v", err)
		}
		if env.Type != protocol.TypePairNegotiationInstruction {
			t.Fatalf("frame %d type = %q; want pair_negotiation_instruction", i+1, env.Type)
		}
		var p protocol.PairNegotiationInstructionPayload
		if err := json.Unmarshal(env.Payload, &p); err != nil {
			t.Fatalf("instruction payload unmarshal: %v", err)
		}
		out = append(out, p)
	}
	return out
}

// sendMediaReady writes a v=2 media_ready envelope on conn.
func sendMediaReady(t *testing.T, conn *websocket.Conn, ctx context.Context, roomID string) {
	t.Helper()
	req := []byte(`{"v":2,"type":"media_ready","roomId":"` + roomID +
		`","payload":{"mediaCapabilities":{"audio":true,"video":true}}}`)
	if err := conn.Write(ctx, websocket.MessageText, req); err != nil {
		t.Fatalf("media_ready write failed: %v", err)
	}
}

// drainOnePerJoiner consumes the per-conn roster_update fan-outs that
// piled up while later peers were joining. earlierIdx is the conn's
// own join index (0-based); the conn received one mesh_roster_update
// for every later joiner (totalJoiners - 1 - earlierIdx of them).
func drainOnePerJoiner(t *testing.T, conn *websocket.Conn, ctx context.Context, n int) {
	t.Helper()
	for i := 0; i < n; i++ {
		env := readMeshFrame(t, conn, ctx)
		if env.Type != protocol.TypeMeshRosterUpdate {
			t.Fatalf("expected mesh_roster_update; got %q", env.Type)
		}
	}
}

// drainAllRosterUpdatesForMediaReady consumes one roster_update on
// every supplied conn. Used after a media_ready broadcast — every
// admitted participant (incl the subject) receives the update.
func drainAllRosterUpdatesForMediaReady(t *testing.T, conns []*websocket.Conn, ctx context.Context) {
	t.Helper()
	for i, c := range conns {
		env := readMeshFrameOfType(t, c, ctx, protocol.TypeMeshRosterUpdate)
		var up protocol.MeshRosterUpdatePayload
		if err := json.Unmarshal(env.Payload, &up); err != nil {
			t.Fatalf("conn[%d] roster update unmarshal: %v", i, err)
		}
		if up.Presence != protocol.PresenceMediaReady {
			t.Fatalf("conn[%d] presence = %q, want media-ready", i, up.Presence)
		}
	}
}

// TestPairInstructionEmittedWhenSecondMediaReady — first half of the
// T045 acceptance: two peers; once the second goes media-ready, both
// endpoints receive exactly one `pair_negotiation_instruction` with
// the correct (offerer, answerer) split and pairEpoch=1.
func TestPairInstructionEmittedWhenSecondMediaReady(t *testing.T) {
	h := mesh.NewHandler(silentLogger())
	ts := httptest.NewServer(h)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	const roomID = "pairinstr"
	connA, peerA, idxA := joinAndExpectAccepted(t, ts, ctx, roomID)
	defer connA.CloseNow()
	_ = drainMeshFrames(t, connA, ctx, 2) // snapshot + own joined update
	connB, peerB, idxB := joinAndExpectAccepted(t, ts, ctx, roomID)
	defer connB.CloseNow()
	_ = drainMeshFrames(t, connB, ctx, 2)
	// A also received B's joined-update.
	_ = readMeshFrameOfType(t, connA, ctx, protocol.TypeMeshRosterUpdate)

	// A goes media-ready first → no instructions emitted (no other
	// media-ready peer). Roster broadcasts are drained but the
	// instruction stream is empty by construction.
	sendMediaReady(t, connA, ctx, roomID)
	drainAllRosterUpdatesForMediaReady(t, []*websocket.Conn{connA, connB}, ctx)

	// B goes media-ready → server emits exactly one pair (1-2): A=offerer, B=answerer.
	sendMediaReady(t, connB, ctx, roomID)
	drainAllRosterUpdatesForMediaReady(t, []*websocket.Conn{connA, connB}, ctx)

	aInstr := readNPairInstructions(t, connA, ctx, 1)
	bInstr := readNPairInstructions(t, connB, ctx, 1)

	wantPair := protocol.MakePairID(idxA, idxB)
	for _, p := range append(aInstr, bInstr...) {
		if p.PairID != wantPair {
			t.Fatalf("pairId = %q, want %q", p.PairID, wantPair)
		}
		if p.PairEpoch != 1 {
			t.Fatalf("pairEpoch = %d, want 1", p.PairEpoch)
		}
		if len(p.IceServers) == 0 {
			t.Fatalf("iceServers empty in instruction")
		}
	}

	if aInstr[0].Role != protocol.RoleOfferer {
		t.Fatalf("A role = %q, want offerer (lower admissionIndex)", aInstr[0].Role)
	}
	if aInstr[0].RemotePeer.PeerID != peerB || aInstr[0].RemotePeer.AdmissionIndex != idxB {
		t.Fatalf("A remotePeer = %+v, want peerB(%s, %d)", aInstr[0].RemotePeer, peerB, idxB)
	}
	if bInstr[0].Role != protocol.RoleAnswerer {
		t.Fatalf("B role = %q, want answerer (higher admissionIndex)", bInstr[0].Role)
	}
	if bInstr[0].RemotePeer.PeerID != peerA || bInstr[0].RemotePeer.AdmissionIndex != idxA {
		t.Fatalf("B remotePeer = %+v, want peerA(%s, %d)", bInstr[0].RemotePeer, peerA, idxA)
	}
}

// TestFourthMediaReadyEmitsExactlyThreeNewPairs — L18 acceptance.
// A/B/C reach media-ready first (forming pairs 1-2, 1-3, 2-3); when
// D becomes media-ready, the server emits exactly the three new pair
// instructions A↔D, B↔D, C↔D (6 unicast envelopes total) and never
// re-emits the existing pairs.
func TestFourthMediaReadyEmitsExactlyThreeNewPairs(t *testing.T) {
	h := mesh.NewHandler(silentLogger())
	ts := httptest.NewServer(h)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()

	const roomID = "mesh4"
	conns := make([]*websocket.Conn, 0, 4)
	peerIDs := make([]string, 0, 4)
	indices := make([]uint64, 0, 4)
	for i := 0; i < 4; i++ {
		c, pid, idx := joinAndExpectAccepted(t, ts, ctx, roomID)
		_ = drainMeshFrames(t, c, ctx, 2) // snapshot + own joined update
		conns = append(conns, c)
		peerIDs = append(peerIDs, pid)
		indices = append(indices, idx)
	}
	// Earlier conns each received a joined update for every later joiner.
	for i := 0; i < 4; i++ {
		drainOnePerJoiner(t, conns[i], ctx, 3-i)
	}

	// Drive A, B, C through media-ready (in admission order). Per
	// transition we know the exact count of instructions each conn
	// receives so we can drain deterministically (no timeout reads —
	// coder/websocket treats ctx cancel as fatal close).
	//
	//   A media-ready: 0 instructions anywhere.
	//   B media-ready: 1 to A (offerer 1-2), 1 to B (answerer 1-2), 0 to C.
	//   C media-ready: 1 to A (offerer 1-3), 1 to B (offerer 2-3), 2 to C
	//                  (answerer 1-3 + 2-3), 0 to D.
	postBCounts := []int{1, 1, 0, 0}
	postCCounts := []int{1, 1, 2, 0}

	sendMediaReady(t, conns[0], ctx, roomID)
	drainAllRosterUpdatesForMediaReady(t, conns, ctx)

	sendMediaReady(t, conns[1], ctx, roomID)
	drainAllRosterUpdatesForMediaReady(t, conns, ctx)
	for i, n := range postBCounts {
		if n == 0 {
			continue
		}
		readNPairInstructions(t, conns[i], ctx, n)
	}

	sendMediaReady(t, conns[2], ctx, roomID)
	drainAllRosterUpdatesForMediaReady(t, conns, ctx)
	for i, n := range postCCounts {
		if n == 0 {
			continue
		}
		readNPairInstructions(t, conns[i], ctx, n)
	}

	// D goes media-ready → exactly three new pairs (1-4, 2-4, 3-4).
	// A, B, C each receive 1 instruction (offerer for their new pair
	// with D); D receives 3 (answerer for all three new pairs).
	sendMediaReady(t, conns[3], ctx, roomID)
	drainAllRosterUpdatesForMediaReady(t, conns, ctx)

	postDCounts := []int{1, 1, 1, 3}
	got := make(map[int][]protocol.PairNegotiationInstructionPayload, 4)
	for i, c := range conns {
		got[i] = readNPairInstructions(t, c, ctx, postDCounts[i])
	}

	// A/B/C each got exactly one new instruction (the new pair with D).
	for i := 0; i < 3; i++ {
		if len(got[i]) != 1 {
			t.Fatalf("conn[%d] got %d new instructions; want 1", i, len(got[i]))
		}
		if got[i][0].Role != protocol.RoleOfferer {
			t.Fatalf("conn[%d] role = %q; want offerer (lower admissionIndex)", i, got[i][0].Role)
		}
		if got[i][0].RemotePeer.PeerID != peerIDs[3] {
			t.Fatalf("conn[%d] remotePeer.peerId = %q; want %q (D)", i, got[i][0].RemotePeer.PeerID, peerIDs[3])
		}
		if got[i][0].PairEpoch != 1 {
			t.Fatalf("conn[%d] pairEpoch = %d; want 1", i, got[i][0].PairEpoch)
		}
	}
	// D gets exactly three instructions, all answerer, distinct pairIds.
	if len(got[3]) != 3 {
		t.Fatalf("D got %d instructions; want 3", len(got[3]))
	}
	seen := map[string]bool{}
	for _, p := range got[3] {
		if p.Role != protocol.RoleAnswerer {
			t.Fatalf("D role = %q; want answerer (higher admissionIndex)", p.Role)
		}
		if p.PairEpoch != 1 {
			t.Fatalf("D pairEpoch = %d; want 1", p.PairEpoch)
		}
		seen[p.PairID] = true
	}
	wantPairs := []string{
		protocol.MakePairID(indices[0], indices[3]),
		protocol.MakePairID(indices[1], indices[3]),
		protocol.MakePairID(indices[2], indices[3]),
	}
	sort.Strings(wantPairs)
	gotPairs := make([]string, 0, len(seen))
	for p := range seen {
		gotPairs = append(gotPairs, p)
	}
	sort.Strings(gotPairs)
	if len(gotPairs) != 3 {
		t.Fatalf("D pairIds = %v; want 3 distinct", gotPairs)
	}
	for i, p := range wantPairs {
		if gotPairs[i] != p {
			t.Fatalf("D pairIds[%d] = %q; want %q", i, gotPairs[i], p)
		}
	}

	// Total unicast envelopes = 3 (to A/B/C) + 3 (to D) = 6.
	total := 0
	for _, lst := range got {
		total += len(lst)
	}
	if total != 6 {
		t.Fatalf("total new unicast pair_negotiation_instruction count = %d; want 6", total)
	}

	for _, c := range conns {
		_ = c.Close(websocket.StatusNormalClosure, "bye")
	}
}
