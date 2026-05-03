// T086 — server `pair_failed` + `reconnect_pair` integration tests
// (contract §3.14–§3.16; M11 / FR-025 + FR-026 + L15).
//
// Drives the in-process /ws/mesh handler through:
//   - admit two peers, get them paired, both at pairEpoch=1
//   - one peer sends `pair_failed` → server flips Pair.State=Failed
//     and forwards the bytes verbatim to the OTHER endpoint
//   - failing peer sends `reconnect_pair { observedEpoch=1 }` → server
//     validates failed precondition + observedEpoch match, increments
//     to epoch=2, emits `pair_reconnect_instruction` to BOTH endpoints
//     with the canonical (lower=offerer, higher=answerer) role split
//   - simultaneous-click race: both peers send `reconnect_pair` at the
//     same observedEpoch — exactly one increments, the other gets
//     `error stale_pair_epoch`
//   - all rejection codes — unknown_pair / not_pair_member / pair_not_failed
//
// Unrelated pairs and roster broadcasts MUST NOT be touched on these
// paths (FR-025, plan §10).

package mesh_test

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"webrtc-lab/signaling/internal/modes/mesh"

	protocol "webrtc-lab/signaling/internal/modes/mesh/protocol"
)

// sendPairFailed writes a v=2 pair_failed envelope on conn for pairId
// + epoch with reason=connection_state_failed. The `to` field is set
// to a placeholder UUID (the server resolves the recipient via the
// pair ledger and rewrites `from`/`to` on relay, mirroring the SDP
// relay path in mesh_pair_epoch_test.go:buildPairSDPEnvelope).
func sendPairFailed(t *testing.T, conn *websocket.Conn, ctx context.Context, roomID, pairID string, epoch uint64) {
	t.Helper()
	payload := map[string]any{
		"pairId":    pairID,
		"pairEpoch": epoch,
		"reason":    "connection_state_failed",
		"detail":    "test induced",
	}
	env := map[string]any{
		"v":       protocol.ContractVersion,
		"type":    "pair_failed",
		"roomId":  roomID,
		"to":      "00000000-0000-4000-8000-000000000001",
		"payload": payload,
	}
	raw, err := json.Marshal(env)
	if err != nil {
		t.Fatalf("env marshal failed: %v", err)
	}
	if err := conn.Write(ctx, websocket.MessageText, raw); err != nil {
		t.Fatalf("pair_failed write failed: %v", err)
	}
}

// sendReconnectPair writes a v=2 reconnect_pair envelope on conn for
// (pairId, observedEpoch). No `to` because §3.14 is C→S only.
func sendReconnectPair(t *testing.T, conn *websocket.Conn, ctx context.Context, roomID, pairID string, observedEpoch uint64) {
	t.Helper()
	payload := map[string]any{
		"pairId":        pairID,
		"observedEpoch": observedEpoch,
	}
	env := map[string]any{
		"v":       protocol.ContractVersion,
		"type":    "reconnect_pair",
		"roomId":  roomID,
		"payload": payload,
	}
	raw, err := json.Marshal(env)
	if err != nil {
		t.Fatalf("env marshal failed: %v", err)
	}
	if err := conn.Write(ctx, websocket.MessageText, raw); err != nil {
		t.Fatalf("reconnect_pair write failed: %v", err)
	}
}

// readPairReconnectInstruction reads one frame and asserts type =
// pair_reconnect_instruction, returning the decoded payload.
func readPairReconnectInstruction(t *testing.T, conn *websocket.Conn, ctx context.Context) protocol.PairReconnectInstructionPayload {
	t.Helper()
	env := readMeshFrameOfType(t, conn, ctx, protocol.TypePairReconnectInstruction)
	var p protocol.PairReconnectInstructionPayload
	if err := json.Unmarshal(env.Payload, &p); err != nil {
		t.Fatalf("pair_reconnect_instruction payload unmarshal: %v", err)
	}
	return p
}

// readErrorEnvelope reads one frame, asserts type=error, and returns
// the parsed payload + envelope. Unlike `expectErrorEnvelope` (which
// only returns the Code), this preserves Message + Context so the
// caller can assert on the canonical-equivalent disambiguator.
func readErrorEnvelope(t *testing.T, conn *websocket.Conn, ctx context.Context) (protocol.Envelope, protocol.ErrorPayload) {
	t.Helper()
	env := readMeshFrameOfType(t, conn, ctx, protocol.TypeError)
	var p protocol.ErrorPayload
	if err := json.Unmarshal(env.Payload, &p); err != nil {
		t.Fatalf("error payload unmarshal: %v", err)
	}
	return env, p
}

// induceFailedPair takes the post-instruction (paired, epoch=1) state
// and drives connA → pair_failed → server marks Pair.State=Failed.
// connB receives the relayed pair_failed envelope (drained here).
func induceFailedPair(t *testing.T, connA, connB *websocket.Conn, ctx context.Context, roomID, pairID string, epoch uint64) {
	t.Helper()
	sendPairFailed(t, connA, ctx, roomID, pairID, epoch)
	relayed := readMeshFrameOfType(t, connB, ctx, protocol.TypePairFailed)
	var p protocol.PairFailedPayload
	if err := json.Unmarshal(relayed.Payload, &p); err != nil {
		t.Fatalf("relayed pair_failed unmarshal: %v", err)
	}
	if p.PairID != pairID || p.PairEpoch != epoch {
		t.Fatalf("relayed pair_failed mismatch: got pairId=%q epoch=%d; want %q %d", p.PairID, p.PairEpoch, pairID, epoch)
	}
	if relayed.From == "" {
		t.Fatalf("relayed pair_failed missing from peerId")
	}
}

// TestPairFailedRelayedToOtherEndpointOnly — §3.16 happy path. The
// other endpoint receives the original payload bytes verbatim; no
// roster update or other broadcast occurs.
func TestPairFailedRelayedToOtherEndpointOnly(t *testing.T) {
	h := mesh.NewHandler(silentLogger(), defaultModeConfig())
	ts := httptest.NewServer(h)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	connA, connB, pairID, epoch := admitPairAndReachInstruction(t, ts, ctx, "failrelay")
	defer connA.CloseNow()
	defer connB.CloseNow()

	sendPairFailed(t, connA, ctx, "failrelay", pairID, epoch)
	relayed := readMeshFrameOfType(t, connB, ctx, protocol.TypePairFailed)
	if relayed.From == "" {
		t.Fatalf("relayed pair_failed missing from")
	}
	var p protocol.PairFailedPayload
	if err := json.Unmarshal(relayed.Payload, &p); err != nil {
		t.Fatalf("relayed pair_failed unmarshal: %v", err)
	}
	if p.PairID != pairID || p.PairEpoch != epoch {
		t.Fatalf("relayed pair_failed mismatch: got (%q, %d); want (%q, %d)",
			p.PairID, p.PairEpoch, pairID, epoch)
	}
	if p.Reason != protocol.PairFailedConnection {
		t.Fatalf("relayed reason = %q; want connection_state_failed", p.Reason)
	}
	// Sender (A) must NOT receive a forwarded copy.
	expectNoFurtherFrame(t, connA)
}

// TestPairFailedDoesNotBroadcastRosterUpdate — FR-025 invariant. The
// server MUST NOT emit a `mesh_roster_update { presence: "failed" }`
// for unrelated room members. Verified by joining a third peer and
// asserting they receive no further frame after the pair_failed.
func TestPairFailedDoesNotBroadcastRosterUpdate(t *testing.T) {
	h := mesh.NewHandler(silentLogger(), defaultModeConfig())
	ts := httptest.NewServer(h)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()

	const roomID = "failnoroster"
	connA, _, idxA := joinAndExpectAccepted(t, ts, ctx, roomID)
	defer connA.CloseNow()
	_ = drainMeshFrames(t, connA, ctx, 2)
	connB, _, idxB := joinAndExpectAccepted(t, ts, ctx, roomID)
	defer connB.CloseNow()
	_ = drainMeshFrames(t, connB, ctx, 2)
	_ = readMeshFrameOfType(t, connA, ctx, protocol.TypeMeshRosterUpdate) // B joined update for A
	connC, _, idxC := joinAndExpectAccepted(t, ts, ctx, roomID)
	defer connC.CloseNow()
	_ = drainMeshFrames(t, connC, ctx, 2)
	_ = readMeshFrameOfType(t, connA, ctx, protocol.TypeMeshRosterUpdate) // C joined update for A
	_ = readMeshFrameOfType(t, connB, ctx, protocol.TypeMeshRosterUpdate) // C joined update for B

	// Drive A, B, C all to media-ready; drain instructions on every
	// conn so reads start fresh below.
	sendMediaReady(t, connA, ctx, roomID)
	drainAllRosterUpdatesForMediaReady(t, []*websocket.Conn{connA, connB, connC}, ctx)
	sendMediaReady(t, connB, ctx, roomID)
	drainAllRosterUpdatesForMediaReady(t, []*websocket.Conn{connA, connB, connC}, ctx)
	readNPairInstructions(t, connA, ctx, 1)
	readNPairInstructions(t, connB, ctx, 1)
	sendMediaReady(t, connC, ctx, roomID)
	drainAllRosterUpdatesForMediaReady(t, []*websocket.Conn{connA, connB, connC}, ctx)
	readNPairInstructions(t, connA, ctx, 1) // A↔C
	readNPairInstructions(t, connB, ctx, 1) // B↔C
	readNPairInstructions(t, connC, ctx, 2) // A↔C + B↔C

	// Fail A↔B only. C should not receive a roster_update or any
	// other frame.
	pairAB := protocol.MakePairID(idxA, idxB)
	sendPairFailed(t, connA, ctx, roomID, pairAB, 1)
	_ = readMeshFrameOfType(t, connB, ctx, protocol.TypePairFailed)
	_ = idxC
	expectNoFurtherFrame(t, connC)
}

// TestReconnectPairHappyPath — §3.14 success path: failed pair,
// observedEpoch matches current; server increments by +1 and emits
// pair_reconnect_instruction to both endpoints with role assignment
// driven by admissionIndex.
func TestReconnectPairHappyPath(t *testing.T) {
	h := mesh.NewHandler(silentLogger(), defaultModeConfig())
	ts := httptest.NewServer(h)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	connA, connB, pairID, epoch := admitPairAndReachInstruction(t, ts, ctx, "reconhappy")
	defer connA.CloseNow()
	defer connB.CloseNow()
	if epoch != 1 {
		t.Fatalf("initial epoch = %d; want 1", epoch)
	}

	induceFailedPair(t, connA, connB, ctx, "reconhappy", pairID, epoch)

	// A is the lower admissionIndex (offerer). Click Reconnect on A.
	sendReconnectPair(t, connA, ctx, "reconhappy", pairID, epoch)

	// Both endpoints receive pair_reconnect_instruction.
	aInstr := readPairReconnectInstruction(t, connA, ctx)
	bInstr := readPairReconnectInstruction(t, connB, ctx)
	if aInstr.PairEpoch != epoch+1 || bInstr.PairEpoch != epoch+1 {
		t.Fatalf("new epoch = (a=%d, b=%d); want both %d", aInstr.PairEpoch, bInstr.PairEpoch, epoch+1)
	}
	if aInstr.Role != protocol.RoleOfferer {
		t.Fatalf("A role = %q; want offerer (lower admissionIndex)", aInstr.Role)
	}
	if bInstr.Role != protocol.RoleAnswerer {
		t.Fatalf("B role = %q; want answerer (higher admissionIndex)", bInstr.Role)
	}
	if aInstr.PairID != pairID || bInstr.PairID != pairID {
		t.Fatalf("pairId mismatch: got (a=%q, b=%q); want %q", aInstr.PairID, bInstr.PairID, pairID)
	}
	if len(aInstr.IceServers) == 0 || len(bInstr.IceServers) == 0 {
		t.Fatalf("iceServers empty on instruction (a=%d, b=%d)", len(aInstr.IceServers), len(bInstr.IceServers))
	}
	// Assert no further frame on B only — coder/websocket cancels the
	// connection on a Read context timeout, which would close connA
	// and trigger a server-side `presence:left` broadcast to connB.
	// One side is enough to prove there's no extra fan-out.
	expectNoFurtherFrame(t, connB)
}

// TestReconnectPairStaleObservedEpochRejected — §3.14 stale path. A
// requester whose observedEpoch < current receives stale_pair_epoch
// and the server does NOT increment again.
func TestReconnectPairStaleObservedEpochRejected(t *testing.T) {
	h := mesh.NewHandler(silentLogger(), defaultModeConfig())
	ts := httptest.NewServer(h)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	connA, connB, pairID, epoch := admitPairAndReachInstruction(t, ts, ctx, "reconstale")
	defer connA.CloseNow()
	defer connB.CloseNow()
	induceFailedPair(t, connA, connB, ctx, "reconstale", pairID, epoch)

	// First request bumps to epoch+1. Drain the instructions on both.
	sendReconnectPair(t, connA, ctx, "reconstale", pairID, epoch)
	_ = readPairReconnectInstruction(t, connA, ctx)
	_ = readPairReconnectInstruction(t, connB, ctx)

	// Mark the pair failed again so reconnect_pair's pair_not_failed
	// guard doesn't shadow the stale-epoch path. (After the first
	// reconnect, server state is PairReconnecting.)
	induceFailedPair(t, connA, connB, ctx, "reconstale", pairID, epoch+1)

	// Re-send with the OLD observedEpoch — should be rejected stale.
	sendReconnectPair(t, connA, ctx, "reconstale", pairID, epoch)
	_, ep := readErrorEnvelope(t, connA, ctx)
	if ep.Code != protocol.CodeStalePairEpoch {
		t.Fatalf("error.code = %q; want stale_pair_epoch", ep.Code)
	}
	// No second instruction follows on B (the un-clicked side). Only
	// assert on B because expectNoFurtherFrame on A would close A and
	// then trigger a `presence:left` broadcast to B.
	expectNoFurtherFrame(t, connB)
}

// TestReconnectPairNotInPairRejected — a third peer sending
// reconnect_pair for someone else's pairId is rejected (canonical
// equivalent of `not_pair_member`). The server does NOT increment.
func TestReconnectPairNotInPairRejected(t *testing.T) {
	h := mesh.NewHandler(silentLogger(), defaultModeConfig())
	ts := httptest.NewServer(h)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()

	const roomID = "reconnotmember"
	connA, _, idxA := joinAndExpectAccepted(t, ts, ctx, roomID)
	defer connA.CloseNow()
	_ = drainMeshFrames(t, connA, ctx, 2)
	connB, _, idxB := joinAndExpectAccepted(t, ts, ctx, roomID)
	defer connB.CloseNow()
	_ = drainMeshFrames(t, connB, ctx, 2)
	_ = readMeshFrameOfType(t, connA, ctx, protocol.TypeMeshRosterUpdate)
	connC, _, _ := joinAndExpectAccepted(t, ts, ctx, roomID)
	defer connC.CloseNow()
	_ = drainMeshFrames(t, connC, ctx, 2)
	_ = readMeshFrameOfType(t, connA, ctx, protocol.TypeMeshRosterUpdate)
	_ = readMeshFrameOfType(t, connB, ctx, protocol.TypeMeshRosterUpdate)

	// Drive A + B to media-ready (forms pair A↔B) — leave C un-paired.
	sendMediaReady(t, connA, ctx, roomID)
	drainAllRosterUpdatesForMediaReady(t, []*websocket.Conn{connA, connB, connC}, ctx)
	sendMediaReady(t, connB, ctx, roomID)
	drainAllRosterUpdatesForMediaReady(t, []*websocket.Conn{connA, connB, connC}, ctx)
	readNPairInstructions(t, connA, ctx, 1)
	readNPairInstructions(t, connB, ctx, 1)

	pairAB := protocol.MakePairID(idxA, idxB)
	induceFailedPair(t, connA, connB, ctx, roomID, pairAB, 1)

	// C tries to reconnect A↔B — must be rejected.
	sendReconnectPair(t, connC, ctx, roomID, pairAB, 1)
	_, ep := readErrorEnvelope(t, connC, ctx)
	if ep.Code != protocol.CodeMalformed {
		t.Fatalf("error.code = %q; want malformed (canonical-equivalent of not_pair_member)", ep.Code)
	}
	if !strings.Contains(ep.Message, "does not belong") {
		t.Fatalf("error.message = %q; want it to mention `does not belong`", ep.Message)
	}
	if subcode, _ := ep.Context["subcode"].(string); subcode != "not_pair_member" {
		t.Fatalf("error.context.subcode = %q; want not_pair_member", subcode)
	}
	// B receives no relay or instruction. (We assert on B only because
	// expectNoFurtherFrame on A closes A and would broadcast presence:
	// left to B, polluting subsequent reads.)
	expectNoFurtherFrame(t, connB)
}

// TestReconnectPairUnknownPairRejected — a request naming a pair the
// server has never registered is rejected as canonical-equivalent of
// `unknown_pair`.
func TestReconnectPairUnknownPairRejected(t *testing.T) {
	h := mesh.NewHandler(silentLogger(), defaultModeConfig())
	ts := httptest.NewServer(h)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	connA, _, _ := joinAndExpectAccepted(t, ts, ctx, "reconunknown")
	defer connA.CloseNow()
	_ = drainMeshFrames(t, connA, ctx, 2)
	sendMediaReady(t, connA, ctx, "reconunknown")
	drainAllRosterUpdatesForMediaReady(t, []*websocket.Conn{connA}, ctx)

	sendReconnectPair(t, connA, ctx, "reconunknown", "9999-99999", 1)
	_, ep := readErrorEnvelope(t, connA, ctx)
	if ep.Code != protocol.CodeStalePairEpoch {
		t.Fatalf("error.code = %q; want stale_pair_epoch (canonical-equivalent of unknown_pair)", ep.Code)
	}
	if subcode, _ := ep.Context["subcode"].(string); subcode != "unknown_pair" {
		t.Fatalf("error.context.subcode = %q; want unknown_pair", subcode)
	}
}

// TestReconnectPairNotFailedRejected — request for a healthy pair (no
// prior pair_failed) is rejected; the server does NOT increment.
func TestReconnectPairNotFailedRejected(t *testing.T) {
	h := mesh.NewHandler(silentLogger(), defaultModeConfig())
	ts := httptest.NewServer(h)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	connA, connB, pairID, epoch := admitPairAndReachInstruction(t, ts, ctx, "reconnotfailed")
	defer connA.CloseNow()
	defer connB.CloseNow()

	sendReconnectPair(t, connA, ctx, "reconnotfailed", pairID, epoch)
	_, ep := readErrorEnvelope(t, connA, ctx)
	if ep.Code != protocol.CodeMalformed {
		t.Fatalf("error.code = %q; want malformed (canonical-equivalent of pair_not_failed)", ep.Code)
	}
	if subcode, _ := ep.Context["subcode"].(string); subcode != "pair_not_failed" {
		t.Fatalf("error.context.subcode = %q; want pair_not_failed", subcode)
	}
	// Other peer receives nothing.
	expectNoFurtherFrame(t, connB)
}

// TestReconnectPairSimultaneousClickRaceProducesOneWinner — R-M3.
// Both endpoints click Reconnect at the same observedEpoch; exactly
// one fresh pair_reconnect_instruction is emitted (epoch=2), the
// other request gets stale_pair_epoch.
func TestReconnectPairSimultaneousClickRaceProducesOneWinner(t *testing.T) {
	h := mesh.NewHandler(silentLogger(), defaultModeConfig())
	ts := httptest.NewServer(h)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()

	connA, connB, pairID, epoch := admitPairAndReachInstruction(t, ts, ctx, "reconrace")
	defer connA.CloseNow()
	defer connB.CloseNow()
	induceFailedPair(t, connA, connB, ctx, "reconrace", pairID, epoch)

	// Send both reconnect_pair frames concurrently. The server's
	// per-room mutex serializes them; one wins (epoch+1, both
	// endpoints get instruction), the other observes the post-bump
	// canonical epoch and gets stale_pair_epoch.
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		sendReconnectPair(t, connA, ctx, "reconrace", pairID, epoch)
	}()
	go func() {
		defer wg.Done()
		sendReconnectPair(t, connB, ctx, "reconrace", pairID, epoch)
	}()
	wg.Wait()

	// Read up to 2 frames per side; classify each by type. We expect:
	//   - exactly 1 pair_reconnect_instruction on A and 1 on B (the
	//     winning pair attempt); both at epoch+1.
	//   - exactly 1 error{stale_pair_epoch} on the loser, 0 on the winner.
	type sideResult struct {
		instructions int
		errors       int
		errorCode    protocol.ErrorCode
	}
	collect := func(conn *websocket.Conn) sideResult {
		var r sideResult
		// Each side receives at most 2 frames in this scenario:
		// one pair_reconnect_instruction + (maybe) one error.
		for i := 0; i < 2; i++ {
			rctx, cancelRead := context.WithTimeout(ctx, 500*time.Millisecond)
			_, raw, err := conn.Read(rctx)
			cancelRead()
			if err != nil {
				return r
			}
			var env protocol.Envelope
			if err := json.Unmarshal(raw, &env); err != nil {
				t.Fatalf("envelope unmarshal: %v", err)
			}
			switch env.Type {
			case protocol.TypePairReconnectInstruction:
				r.instructions++
			case protocol.TypeError:
				r.errors++
				var ep protocol.ErrorPayload
				_ = json.Unmarshal(env.Payload, &ep)
				r.errorCode = ep.Code
			default:
				t.Fatalf("unexpected frame type during race: %q", env.Type)
			}
		}
		return r
	}
	a := collect(connA)
	b := collect(connB)

	totalInstructions := a.instructions + b.instructions
	totalErrors := a.errors + b.errors
	if totalInstructions != 2 {
		t.Fatalf("expected exactly one fresh attempt (2 instructions total, one per endpoint); got A=%d B=%d", a.instructions, b.instructions)
	}
	if totalErrors != 1 {
		t.Fatalf("expected exactly one stale_pair_epoch loser; got A.errors=%d B.errors=%d", a.errors, b.errors)
	}
	loserCode := a.errorCode
	if a.errors == 0 {
		loserCode = b.errorCode
	}
	if loserCode != protocol.CodeStalePairEpoch {
		t.Fatalf("loser error.code = %q; want stale_pair_epoch", loserCode)
	}
}

// TestReconnectPairRemoteEndpointDisconnectedRejected — race
// coverage. After `pair_failed`, the failing peer's WebSocket closes
// (Manager.Release runs and removes the participant from
// r.participants while the pair entry survives because pairLedger.Drop
// is not called on participant release). The surviving peer's
// reconnect_pair MUST be rejected with `not_in_room` rather than
// nil-deref'ing on the missing remote inside the `emitOne` closure or
// silently corrupting the epoch (bumping with no instruction emitted,
// which would leave the surviving client unable to ever reconnect that
// pair — every later attempt would carry observedEpoch < server.epoch
// and be rejected as stale_pair_epoch indefinitely).
func TestReconnectPairRemoteEndpointDisconnectedRejected(t *testing.T) {
	h := mesh.NewHandler(silentLogger(), defaultModeConfig())
	ts := httptest.NewServer(h)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()

	const roomID = "reconremoteleft"
	connA, connB, pairID, epoch := admitPairAndReachInstruction(t, ts, ctx, roomID)
	defer connA.CloseNow()
	// Do NOT defer connB.CloseNow() — we close it explicitly below.

	induceFailedPair(t, connA, connB, ctx, roomID, pairID, epoch)

	// B disconnects ungracefully. Synchronize on A's `peer_left` —
	// emitted by the same locked critical section as Manager.Release —
	// so we know the participant is gone from r.participants by the
	// time we send reconnect_pair below.
	_ = connB.CloseNow()
	_ = readUntilPeerLeft(t, ctx, connA, "")

	// A clicks Reconnect on the orphaned pair. Server must refuse
	// without panicking, without bumping the epoch, and without
	// emitting any pair_reconnect_instruction.
	sendReconnectPair(t, connA, ctx, roomID, pairID, epoch)
	_, ep := readErrorEnvelope(t, connA, ctx)
	if ep.Code != protocol.CodeNotInRoom {
		t.Fatalf("error.code = %q; want not_in_room", ep.Code)
	}
	if subcode, _ := ep.Context["subcode"].(string); subcode != "remote_left" {
		t.Fatalf("error.context.subcode = %q; want remote_left", subcode)
	}
	if pid, _ := ep.Context["pairId"].(string); pid != pairID {
		t.Fatalf("error.context.pairId = %q; want %q", pid, pairID)
	}
	// No follow-up frames on A — no instruction was minted.
	expectNoFurtherFrame(t, connA)
}

// TestReconnectPairOnlyTouchesAffectedPair — verify FR-025 isolation
// at the server level: in a 3-peer room (A, B, C all paired), failing
// + reconnecting A↔B does NOT mutate A↔C or B↔C ledger entries and
// does NOT emit any frame on C's wire.
func TestReconnectPairOnlyTouchesAffectedPair(t *testing.T) {
	h := mesh.NewHandler(silentLogger(), defaultModeConfig())
	ts := httptest.NewServer(h)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()

	const roomID = "reconisolate"
	connA, _, idxA := joinAndExpectAccepted(t, ts, ctx, roomID)
	defer connA.CloseNow()
	_ = drainMeshFrames(t, connA, ctx, 2)
	connB, _, idxB := joinAndExpectAccepted(t, ts, ctx, roomID)
	defer connB.CloseNow()
	_ = drainMeshFrames(t, connB, ctx, 2)
	_ = readMeshFrameOfType(t, connA, ctx, protocol.TypeMeshRosterUpdate)
	connC, _, _ := joinAndExpectAccepted(t, ts, ctx, roomID)
	defer connC.CloseNow()
	_ = drainMeshFrames(t, connC, ctx, 2)
	_ = readMeshFrameOfType(t, connA, ctx, protocol.TypeMeshRosterUpdate)
	_ = readMeshFrameOfType(t, connB, ctx, protocol.TypeMeshRosterUpdate)

	sendMediaReady(t, connA, ctx, roomID)
	drainAllRosterUpdatesForMediaReady(t, []*websocket.Conn{connA, connB, connC}, ctx)
	sendMediaReady(t, connB, ctx, roomID)
	drainAllRosterUpdatesForMediaReady(t, []*websocket.Conn{connA, connB, connC}, ctx)
	readNPairInstructions(t, connA, ctx, 1)
	readNPairInstructions(t, connB, ctx, 1)
	sendMediaReady(t, connC, ctx, roomID)
	drainAllRosterUpdatesForMediaReady(t, []*websocket.Conn{connA, connB, connC}, ctx)
	readNPairInstructions(t, connA, ctx, 1)
	readNPairInstructions(t, connB, ctx, 1)
	readNPairInstructions(t, connC, ctx, 2)

	pairAB := protocol.MakePairID(idxA, idxB)
	induceFailedPair(t, connA, connB, ctx, roomID, pairAB, 1)
	sendReconnectPair(t, connA, ctx, roomID, pairAB, 1)
	aInstr := readPairReconnectInstruction(t, connA, ctx)
	bInstr := readPairReconnectInstruction(t, connB, ctx)
	if aInstr.PairID != pairAB || bInstr.PairID != pairAB {
		t.Fatalf("instruction pairId mismatch: a=%q b=%q want %q", aInstr.PairID, bInstr.PairID, pairAB)
	}
	if aInstr.PairEpoch != 2 || bInstr.PairEpoch != 2 {
		t.Fatalf("instruction epoch mismatch: a=%d b=%d want 2", aInstr.PairEpoch, bInstr.PairEpoch)
	}
	// C must observe NO traffic for this whole reconnect cycle.
	expectNoFurtherFrame(t, connC)
}
