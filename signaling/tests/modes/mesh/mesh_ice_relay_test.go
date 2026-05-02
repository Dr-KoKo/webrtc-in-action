// T055 — pair_ice_candidate relay integration tests (contract §3.12).
// Drives the in-process /ws/mesh handler: admit A,B → both
// media-ready → drain pair instructions → A sends pair_ice_candidate
// → server validates + relays to B without parsing the candidate
// string. Verifies:
//   - normal candidate is forwarded byte-for-byte to the other endpoint
//   - candidate:null is preserved as end-of-candidates
//   - candidate:"" is rejected with `error { code: "malformed" }`
//   - stale pairEpoch is rejected with `error { code: "stale_pair_epoch" }`
//   - no frame leaks to unrelated room members
//   - server does not mutate or parse the candidate payload (the
//     relay forwards extra/unknown fields untouched)
//
// (M2 already covers the pure validator surface in
// `protocol_pair_test.go`; this file proves the live relay.)

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

// buildPairIceEnvelope marshals a v=2 pair_ice_candidate envelope. The
// `candidate` argument is included verbatim — pass nil to send
// `candidate: null`, or any json.RawMessage to send a custom shape.
// The handler stamps `from`/`to` itself on relay.
func buildPairIceEnvelope(t *testing.T, roomID, pairID string, epoch uint64, candidate json.RawMessage) []byte {
	t.Helper()
	payload := map[string]json.RawMessage{
		"pairId":    mustMarshal(t, pairID),
		"pairEpoch": mustMarshal(t, epoch),
		"candidate": candidate,
	}
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("payload marshal: %v", err)
	}
	env := map[string]any{
		"v":       mesh.ContractVersion,
		"type":    "pair_ice_candidate",
		"roomId":  roomID,
		"to":      "00000000-0000-4000-8000-000000000001",
		"payload": json.RawMessage(payloadBytes),
	}
	raw, err := json.Marshal(env)
	if err != nil {
		t.Fatalf("env marshal: %v", err)
	}
	return raw
}

func mustMarshal(t *testing.T, v any) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return b
}

// TestValidPairIceCandidateRelayedOnce — a normal candidate sent by A
// is forwarded once to B with `from` set to A's peer ID, byte-for-byte
// (extra/unknown fields preserved).
func TestValidPairIceCandidateRelayedOnce(t *testing.T) {
	h := mesh.NewHandler(silentLogger())
	ts := httptest.NewServer(h)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	connA, connB, pairID, epoch := admitPairAndReachInstruction(t, ts, ctx, "ice")
	defer connA.CloseNow()
	defer connB.CloseNow()

	// A custom candidate object with an `extraField` the server MUST
	// preserve (NFR-003 — no server parsing or mutation).
	candidate := json.RawMessage(`{"candidate":"candidate:1 1 UDP 100 1.2.3.4 1234 typ host","sdpMid":"0","sdpMLineIndex":0,"usernameFragment":"abcd","extraField":"server-MUST-pass-through"}`)
	raw := buildPairIceEnvelope(t, "ice", pairID, epoch, candidate)
	if err := connA.Write(ctx, websocket.MessageText, raw); err != nil {
		t.Fatalf("A write pair_ice_candidate failed: %v", err)
	}

	got := readMeshFrameOfType(t, connB, ctx, mesh.TypePairIceCandidate)
	if got.From == "" {
		t.Fatalf("relayed pair_ice_candidate missing `from` peer id")
	}
	// Decode the relayed payload as a generic object so the unknown
	// field assertion is straightforward.
	var raw2 map[string]json.RawMessage
	if err := json.Unmarshal(got.Payload, &raw2); err != nil {
		t.Fatalf("relayed payload unmarshal: %v", err)
	}
	var pid string
	if err := json.Unmarshal(raw2["pairId"], &pid); err != nil {
		t.Fatalf("pairId unmarshal: %v", err)
	}
	if pid != pairID {
		t.Fatalf("relayed pairId = %q; want %q", pid, pairID)
	}
	var ep uint64
	if err := json.Unmarshal(raw2["pairEpoch"], &ep); err != nil {
		t.Fatalf("pairEpoch unmarshal: %v", err)
	}
	if ep != epoch {
		t.Fatalf("relayed pairEpoch = %d; want %d", ep, epoch)
	}
	// The candidate object MUST be preserved verbatim, including the
	// `extraField` we stuffed in.
	candFwd := raw2["candidate"]
	var candObj map[string]any
	if err := json.Unmarshal(candFwd, &candObj); err != nil {
		t.Fatalf("relayed candidate unmarshal: %v", err)
	}
	if candObj["extraField"] != "server-MUST-pass-through" {
		t.Fatalf("server mutated candidate; extraField=%v", candObj["extraField"])
	}
	if candObj["candidate"] == nil {
		t.Fatalf("server lost candidate.candidate field")
	}
	expectNoFurtherFrame(t, connB)
}

// TestPairIceCandidateNullRelayed — `candidate: null` (end-of-candidates)
// is preserved and forwarded; the relayed payload's `candidate` key is
// JSON null.
func TestPairIceCandidateNullRelayed(t *testing.T) {
	h := mesh.NewHandler(silentLogger())
	ts := httptest.NewServer(h)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	connA, connB, pairID, epoch := admitPairAndReachInstruction(t, ts, ctx, "icenull")
	defer connA.CloseNow()
	defer connB.CloseNow()

	raw := buildPairIceEnvelope(t, "icenull", pairID, epoch, json.RawMessage(`null`))
	if err := connA.Write(ctx, websocket.MessageText, raw); err != nil {
		t.Fatalf("A write pair_ice_candidate (null) failed: %v", err)
	}
	got := readMeshFrameOfType(t, connB, ctx, mesh.TypePairIceCandidate)
	var raw2 map[string]json.RawMessage
	if err := json.Unmarshal(got.Payload, &raw2); err != nil {
		t.Fatalf("relayed payload unmarshal: %v", err)
	}
	if string(raw2["candidate"]) != "null" {
		t.Fatalf("relayed candidate = %q; want null", string(raw2["candidate"]))
	}
}

// TestPairIceCandidateEmptyStringRejectedAsMalformed — `candidate: ""`
// is invalid (use null instead). The server returns
// `error { code: "malformed" }` and does NOT forward.
func TestPairIceCandidateEmptyStringRejectedAsMalformed(t *testing.T) {
	h := mesh.NewHandler(silentLogger())
	ts := httptest.NewServer(h)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	connA, connB, pairID, epoch := admitPairAndReachInstruction(t, ts, ctx, "iceempty")
	defer connA.CloseNow()
	defer connB.CloseNow()

	cand := json.RawMessage(`{"candidate":"","sdpMid":"0","sdpMLineIndex":0}`)
	raw := buildPairIceEnvelope(t, "iceempty", pairID, epoch, cand)
	if err := connA.Write(ctx, websocket.MessageText, raw); err != nil {
		t.Fatalf("A write pair_ice_candidate (empty) failed: %v", err)
	}

	got := readMeshFrameOfType(t, connA, ctx, mesh.TypeError)
	var ep mesh.ErrorPayload
	if err := json.Unmarshal(got.Payload, &ep); err != nil {
		t.Fatalf("error payload unmarshal: %v", err)
	}
	if ep.Code != mesh.CodeMalformed {
		t.Fatalf("error.code = %q; want malformed", ep.Code)
	}
	expectNoFurtherFrame(t, connB)
}

// TestPairIceCandidateStaleEpochRejected — pair_ice_candidate with
// pairEpoch != server's current returns `error stale_pair_epoch` and
// is NOT forwarded.
func TestPairIceCandidateStaleEpochRejected(t *testing.T) {
	h := mesh.NewHandler(silentLogger())
	ts := httptest.NewServer(h)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	connA, connB, pairID, epoch := admitPairAndReachInstruction(t, ts, ctx, "icestale")
	defer connA.CloseNow()
	defer connB.CloseNow()

	cand := json.RawMessage(`{"candidate":"candidate:1 1 UDP 100 1.2.3.4 1234 typ host","sdpMid":"0","sdpMLineIndex":0}`)
	staleRaw := buildPairIceEnvelope(t, "icestale", pairID, epoch+5, cand)
	if err := connA.Write(ctx, websocket.MessageText, staleRaw); err != nil {
		t.Fatalf("A write stale pair_ice_candidate failed: %v", err)
	}
	got := readMeshFrameOfType(t, connA, ctx, mesh.TypeError)
	var ep mesh.ErrorPayload
	if err := json.Unmarshal(got.Payload, &ep); err != nil {
		t.Fatalf("error payload unmarshal: %v", err)
	}
	if ep.Code != mesh.CodeStalePairEpoch {
		t.Fatalf("error.code = %q; want stale_pair_epoch", ep.Code)
	}
	expectNoFurtherFrame(t, connB)
}

// TestPairIceCandidateNotRelayedToUnrelatedPeer — when a third peer
// is admitted, an A↔B pair_ice_candidate must NOT be forwarded to C.
func TestPairIceCandidateNotRelayedToUnrelatedPeer(t *testing.T) {
	h := mesh.NewHandler(silentLogger())
	ts := httptest.NewServer(h)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	roomID := "iceisolation"
	connA, connB, pairID, epoch := admitPairAndReachInstruction(t, ts, ctx, roomID)
	defer connA.CloseNow()
	defer connB.CloseNow()

	// Admit a third peer. Per handleJoinRoom order, C receives:
	//   join_accepted, mesh_roster_snapshot, mesh_roster_update (joined)
	// joinAndExpectAccepted reads only join_accepted; drainMeshFrames(2)
	// reads the next two — snapshot + roster_update for C joining.
	// A and B each receive one roster_update broadcast (C joined).
	connC, _, _ := joinAndExpectAccepted(t, ts, ctx, roomID)
	defer connC.CloseNow()
	_ = drainMeshFrames(t, connC, ctx, 2)
	_ = readMeshFrameOfType(t, connA, ctx, mesh.TypeMeshRosterUpdate)
	_ = readMeshFrameOfType(t, connB, ctx, mesh.TypeMeshRosterUpdate)

	// A sends an A↔B candidate. C must not see it.
	cand := json.RawMessage(`{"candidate":"candidate:1 1 UDP 100 1.2.3.4 1234 typ host","sdpMid":"0","sdpMLineIndex":0}`)
	raw := buildPairIceEnvelope(t, roomID, pairID, epoch, cand)
	if err := connA.Write(ctx, websocket.MessageText, raw); err != nil {
		t.Fatalf("A write pair_ice_candidate failed: %v", err)
	}
	got := readMeshFrameOfType(t, connB, ctx, mesh.TypePairIceCandidate)
	if got.From == "" {
		t.Fatalf("relayed envelope missing `from`")
	}
	// C must not receive a pair_ice_candidate within a short window.
	expectNoFurtherFrame(t, connC)
}
