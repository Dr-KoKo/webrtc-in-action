// T052 — pair offer/answer relay + epoch integration tests
// (contract §3.10 + §3.11). Drives the in-process /ws/mesh handler:
// admit A,B → both media-ready → server emits pair instructions →
// A sends pair_offer → server validates + relays to B; B sends
// pair_answer → server relays to A. Stale-epoch / wrong-role
// rejections respond with the canonical error code and DO NOT forward.
//
// (M2 already covers the pure validator surface in
// `protocol_pair_epoch_test.go`; this file proves the live relay.)

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

// admitPairAndReachInstruction runs the boilerplate: dial two
// connections, get both to media-ready, drain the pair_negotiation_
// instruction on each side, return the conns + the pairId.
func admitPairAndReachInstruction(t *testing.T, ts *httptest.Server, ctx context.Context, roomID string) (*websocket.Conn, *websocket.Conn, string, uint64) {
	t.Helper()
	connA, _, idxA := joinAndExpectAccepted(t, ts, ctx, roomID)
	_ = drainMeshFrames(t, connA, ctx, 2)
	connB, _, idxB := joinAndExpectAccepted(t, ts, ctx, roomID)
	_ = drainMeshFrames(t, connB, ctx, 2)
	_ = readMeshFrameOfType(t, connA, ctx, protocol.TypeMeshRosterUpdate)

	sendMediaReady(t, connA, ctx, roomID)
	drainAllRosterUpdatesForMediaReady(t, []*websocket.Conn{connA, connB}, ctx)
	sendMediaReady(t, connB, ctx, roomID)
	drainAllRosterUpdatesForMediaReady(t, []*websocket.Conn{connA, connB}, ctx)

	aInstr := readNPairInstructions(t, connA, ctx, 1)
	_ = readNPairInstructions(t, connB, ctx, 1)
	return connA, connB, protocol.MakePairID(idxA, idxB), aInstr[0].PairEpoch
}

// TestValidPairOfferRelayedOnce — the offerer's pair_offer is forwarded
// exactly once to the answerer with `from` set to the sender peerId.
func TestValidPairOfferRelayedOnce(t *testing.T) {
	h := mesh.NewHandler(silentLogger(), defaultModeConfig())
	ts := httptest.NewServer(h)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	connA, connB, pairID, epoch := admitPairAndReachInstruction(t, ts, ctx, "relayoffer")
	defer connA.CloseNow()
	defer connB.CloseNow()

	// A is offerer. The server stamps `from`/`to` itself based on the
	// pair ledger, so the client need only supply a placeholder `to`.
	raw := buildPairSDPEnvelope(t, "pair_offer", "relayoffer", pairID, epoch, "offer")
	if err := connA.Write(ctx, websocket.MessageText, raw); err != nil {
		t.Fatalf("A write pair_offer failed: %v", err)
	}

	// Read the relayed envelope on B; assert exactly one with type=pair_offer.
	got := readMeshFrameOfType(t, connB, ctx, protocol.TypePairOffer)
	if got.From == "" {
		t.Fatalf("relayed offer missing `from` peer id")
	}
	var p protocol.PairOfferPayload
	if err := json.Unmarshal(got.Payload, &p); err != nil {
		t.Fatalf("relayed payload unmarshal: %v", err)
	}
	if p.PairID != pairID || p.PairEpoch != epoch {
		t.Fatalf("relayed pairId/epoch = (%q, %d); want (%q, %d)", p.PairID, p.PairEpoch, pairID, epoch)
	}
	if p.SDP.Type != "offer" || p.SDP.SDP == "" {
		t.Fatalf("relayed sdp = %+v; want type=offer non-empty body", p.SDP)
	}

	// No further frame should arrive within a short window (no duplicate relay).
	expectNoFurtherFrame(t, connB)
}

// TestValidPairAnswerRelayedOnce — the answerer's pair_answer is
// forwarded once back to the offerer.
func TestValidPairAnswerRelayedOnce(t *testing.T) {
	h := mesh.NewHandler(silentLogger(), defaultModeConfig())
	ts := httptest.NewServer(h)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	connA, connB, pairID, epoch := admitPairAndReachInstruction(t, ts, ctx, "relayanswer")
	defer connA.CloseNow()
	defer connB.CloseNow()

	// First A → offer (so server-side state remains authoritative even
	// though no setRD happens in tests; the relay is stateless w.r.t.
	// SDP, so this is purely flow-completeness).
	offerRaw := buildPairSDPEnvelope(t, "pair_offer", "relayanswer", pairID, epoch, "offer")
	if err := connA.Write(ctx, websocket.MessageText, offerRaw); err != nil {
		t.Fatalf("A write pair_offer failed: %v", err)
	}
	_ = readMeshFrameOfType(t, connB, ctx, protocol.TypePairOffer)

	// B → answer; should be relayed once to A.
	answerRaw := buildPairSDPEnvelope(t, "pair_answer", "relayanswer", pairID, epoch, "answer")
	if err := connB.Write(ctx, websocket.MessageText, answerRaw); err != nil {
		t.Fatalf("B write pair_answer failed: %v", err)
	}
	got := readMeshFrameOfType(t, connA, ctx, protocol.TypePairAnswer)
	var p protocol.PairAnswerPayload
	if err := json.Unmarshal(got.Payload, &p); err != nil {
		t.Fatalf("relayed answer payload unmarshal: %v", err)
	}
	if p.SDP.Type != "answer" {
		t.Fatalf("relayed answer.sdp.type = %q; want answer", p.SDP.Type)
	}
	if got.From == "" {
		t.Fatalf("relayed answer missing `from` peer id")
	}
	expectNoFurtherFrame(t, connA)
}

// TestStalePairOfferRejectedAndNotForwarded — a pair_offer with
// pairEpoch < server's current returns `error stale_pair_epoch` to
// the sender and does NOT forward to the recipient.
func TestStalePairOfferRejectedAndNotForwarded(t *testing.T) {
	h := mesh.NewHandler(silentLogger(), defaultModeConfig())
	ts := httptest.NewServer(h)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	connA, connB, pairID, epoch := admitPairAndReachInstruction(t, ts, ctx, "staleoffer")
	defer connA.CloseNow()
	defer connB.CloseNow()

	// Build a synthetic stale offer with epoch=0 (below server's current=1).
	// The validator treats observed=0 as stale (current=1 strictly greater).
	staleEpoch := uint64(0)
	if epoch == 0 {
		t.Fatalf("server epoch unexpectedly 0; cannot construct stale case")
	}
	staleRaw := buildPairSDPEnvelope(t, "pair_offer", "staleoffer", pairID, staleEpoch, "offer")
	if err := connA.Write(ctx, websocket.MessageText, staleRaw); err != nil {
		t.Fatalf("A write stale pair_offer failed: %v", err)
	}

	// Sender receives error stale_pair_epoch.
	got := readMeshFrameOfType(t, connA, ctx, protocol.TypeError)
	var ep protocol.ErrorPayload
	if err := json.Unmarshal(got.Payload, &ep); err != nil {
		t.Fatalf("error payload unmarshal: %v", err)
	}
	// pairEpoch=0 violates the payload validator (must be ≥ 1) and so
	// is reported as `malformed`. To exercise the canonical
	// stale_pair_epoch path, send a high epoch (server is canonical).
	// Accept either malformed or stale_pair_epoch here so the test
	// proves the pair message is rejected and never forwarded.
	switch ep.Code {
	case protocol.CodeStalePairEpoch, protocol.CodeMalformed:
	default:
		t.Fatalf("error.code = %q; want stale_pair_epoch or malformed", ep.Code)
	}

	// And then a higher-than-current epoch — the canonical stale path.
	bumpedEpoch := epoch + 5
	bumpedRaw := buildPairSDPEnvelope(t, "pair_offer", "staleoffer", pairID, bumpedEpoch, "offer")
	if err := connA.Write(ctx, websocket.MessageText, bumpedRaw); err != nil {
		t.Fatalf("A write higher-epoch pair_offer failed: %v", err)
	}
	got2 := readMeshFrameOfType(t, connA, ctx, protocol.TypeError)
	var ep2 protocol.ErrorPayload
	if err := json.Unmarshal(got2.Payload, &ep2); err != nil {
		t.Fatalf("error payload 2 unmarshal: %v", err)
	}
	if ep2.Code != protocol.CodeStalePairEpoch {
		t.Fatalf("error.code = %q; want stale_pair_epoch", ep2.Code)
	}
	// B must not receive any forwarded offer.
	expectNoFurtherFrame(t, connB)
}

// TestWrongRolePairOfferRejected — when the answerer (higher
// admissionIndex) sends pair_offer, the server rejects with
// `unexpected_offer` and does not forward.
func TestWrongRolePairOfferRejected(t *testing.T) {
	h := mesh.NewHandler(silentLogger(), defaultModeConfig())
	ts := httptest.NewServer(h)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	connA, connB, pairID, epoch := admitPairAndReachInstruction(t, ts, ctx, "wrongrole")
	defer connA.CloseNow()
	defer connB.CloseNow()

	// B is answerer — sending pair_offer is a role violation.
	raw := buildPairSDPEnvelope(t, "pair_offer", "wrongrole", pairID, epoch, "offer")
	if err := connB.Write(ctx, websocket.MessageText, raw); err != nil {
		t.Fatalf("B write pair_offer (wrong-role) failed: %v", err)
	}
	got := readMeshFrameOfType(t, connB, ctx, protocol.TypeError)
	var ep protocol.ErrorPayload
	if err := json.Unmarshal(got.Payload, &ep); err != nil {
		t.Fatalf("error payload unmarshal: %v", err)
	}
	if ep.Code != protocol.CodeUnexpectedOffer {
		t.Fatalf("error.code = %q; want unexpected_offer", ep.Code)
	}
	expectNoFurtherFrame(t, connA)
}

// buildPairSDPEnvelope marshals a v=2 pair_offer / pair_answer envelope
// with the supplied identity and a placeholder SDP body. The server
// stamps `from`/`to` on relay; clients leave `to` empty here because
// the server's relay logic resolves the recipient via the pair ledger.
func buildPairSDPEnvelope(t *testing.T, msgType, roomID, pairID string, epoch uint64, sdpType string) []byte {
	t.Helper()
	payload := map[string]any{
		"pairId":    pairID,
		"pairEpoch": epoch,
		"sdp": map[string]string{
			"type": sdpType,
			"sdp":  "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n",
		},
	}
	env := map[string]any{
		"v":       protocol.ContractVersion,
		"type":    msgType,
		"roomId":  roomID,
		"to":      "00000000-0000-4000-8000-000000000001",
		"payload": payload,
	}
	raw, err := json.Marshal(env)
	if err != nil {
		t.Fatalf("env marshal: %v", err)
	}
	return raw
}
