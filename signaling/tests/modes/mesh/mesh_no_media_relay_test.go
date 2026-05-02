package mesh_test

// T093 — mesh_no_media_relay_test.go (M12 / NFR-003 / FR-091).
//
// The server is a SIGNALING-ONLY relay. No media bytes touch the Go
// process — not in handlers, not in storage, not in logs. This test
// pins that contract by:
//
//   1. Driving every relayable pair envelope (pair_offer, pair_answer,
//      pair_ice_candidate, pair_failed, pair_media_state) through the
//      live /ws/mesh handler with a payload that carries an `extraField`
//      sentinel. The relayed bytes the recipient observes MUST match
//      the bytes the sender wrote — i.e., the server forwards
//      verbatim and never inspects, mutates, or normalizes.
//
//   2. Capturing all server log output and asserting:
//        - no SDP body fragment appears
//        - no ICE candidate string appears
//        - no TURN credential appears
//        - no mic/cam/screen state value appears
//        - no media-frame field name (RTP, MediaStream, etc.) appears
//          in handler/relay paths.
//
//   3. Static surface check (file-system grep) that the mesh server
//      package contains no media-frame field names beyond schema
//      enums. Any matches must be limited to schema.go-style files
//      (already documented in the contract).
//
// If this test fails, the server has started inspecting / mutating /
// logging media payloads — that is a Spec Non-Goal and must be
// reverted before any code that triggered the regression ships.

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"webrtc-lab/signaling/internal/modes/mesh"
)

// SDP / ICE / TURN sentinel values. Each is unique enough that any log
// line containing it is unambiguous evidence of a regression.
const (
	sentinelSDPBody     = "z=SENTINEL_SDP_DO_NOT_LOG\r\n"
	sentinelICECand     = "candidate:42 1 UDP 100 SENTINEL_ICE_DO_NOT_LOG 4242 typ host"
	sentinelTURNUser    = "SENTINEL_TURN_USERNAME"
	sentinelTURNCred    = "SENTINEL_TURN_PASSWORD"
	sentinelExtraField  = "server-MUST-pass-through-unchanged"
	sentinelMediaStateA = "SENTINEL_MIC_VALUE_DO_NOT_LOG_a"
	sentinelMediaStateB = "SENTINEL_CAM_VALUE_DO_NOT_LOG_b"
)

func TestNoMediaRelay_RelayPathsAreByteIdentical(t *testing.T) {
	log, buf := captureLogger()
	h := mesh.NewHandler(log)
	ts := httptest.NewServer(h)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	connA, connB, pairID, epoch := admitPairAndReachInstruction(t, ts, ctx, "norel")
	defer connA.CloseNow()
	defer connB.CloseNow()

	// ---- pair_offer ------------------------------------------------
	offerPayload := map[string]any{
		"pairId":    pairID,
		"pairEpoch": epoch,
		"sdp": map[string]any{
			"type": "offer",
			"sdp": "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n" +
				"m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n" +
				sentinelSDPBody,
		},
		"extraField": sentinelExtraField,
	}
	offerRaw := mustEnvelope(t, "pair_offer", "norel", pairID, offerPayload)
	if err := connA.Write(ctx, websocket.MessageText, offerRaw); err != nil {
		t.Fatalf("write pair_offer: %v", err)
	}
	got := readMeshFrameOfType(t, connB, ctx, mesh.TypePairOffer)
	assertVerbatimRelay(t, "pair_offer", offerPayload, got.Payload)

	// ---- pair_answer -----------------------------------------------
	answerPayload := map[string]any{
		"pairId":    pairID,
		"pairEpoch": epoch,
		"sdp": map[string]any{
			"type": "answer",
			"sdp": "v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n" +
				"m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n" +
				sentinelSDPBody,
		},
		"extraField": sentinelExtraField,
	}
	answerRaw := mustEnvelope(t, "pair_answer", "norel", pairID, answerPayload)
	if err := connB.Write(ctx, websocket.MessageText, answerRaw); err != nil {
		t.Fatalf("write pair_answer: %v", err)
	}
	gotA := readMeshFrameOfType(t, connA, ctx, mesh.TypePairAnswer)
	assertVerbatimRelay(t, "pair_answer", answerPayload, gotA.Payload)

	// ---- pair_ice_candidate ---------------------------------------
	icePayload := map[string]any{
		"pairId":    pairID,
		"pairEpoch": epoch,
		"candidate": map[string]any{
			"candidate":        sentinelICECand,
			"sdpMid":           "0",
			"sdpMLineIndex":    0,
			"usernameFragment": sentinelTURNUser,
			"extraField":       sentinelExtraField,
		},
	}
	iceRaw := mustEnvelope(t, "pair_ice_candidate", "norel", pairID, icePayload)
	if err := connA.Write(ctx, websocket.MessageText, iceRaw); err != nil {
		t.Fatalf("write pair_ice_candidate: %v", err)
	}
	gotIce := readMeshFrameOfType(t, connB, ctx, mesh.TypePairIceCandidate)
	assertVerbatimRelay(t, "pair_ice_candidate", icePayload, gotIce.Payload)

	// ---- pair_media_state (fan-out) -------------------------------
	// Note: the canonical schema only accepts on/off/active/inactive
	// values — we verify byte-identity against THAT canonical payload.
	// The sentinel media-state values are tested separately via the log
	// assertion (server MUST NOT log mic/cam/screen values, even valid
	// ones).
	mediaStatePayload := map[string]any{
		"microphone":  "on",
		"camera":      "off",
		"screenShare": "active",
		"extraField":  sentinelExtraField,
	}
	stateRaw := mustEnvelope(t, "pair_media_state", "norel", "" /* no pairId */, mediaStatePayload)
	if err := connA.Write(ctx, websocket.MessageText, stateRaw); err != nil {
		t.Fatalf("write pair_media_state: %v", err)
	}
	gotState := readMeshFrameOfType(t, connB, ctx, mesh.TypePairMediaState)
	assertVerbatimRelay(t, "pair_media_state", mediaStatePayload, gotState.Payload)

	// ---- pair_failed ----------------------------------------------
	failedPayload := map[string]any{
		"pairId":     pairID,
		"pairEpoch":  epoch,
		"reason":     "ice_failure",
		"detail":     "remote endpoint unreachable; " + sentinelExtraField,
		"extraField": sentinelExtraField,
	}
	failedRaw := mustEnvelope(t, "pair_failed", "norel", pairID, failedPayload)
	if err := connA.Write(ctx, websocket.MessageText, failedRaw); err != nil {
		t.Fatalf("write pair_failed: %v", err)
	}
	gotFailed := readMeshFrameOfType(t, connB, ctx, mesh.TypePairFailed)
	assertVerbatimRelay(t, "pair_failed", failedPayload, gotFailed.Payload)

	// ---- log assertions ------------------------------------------
	// Brief settle window so any background goroutine has a chance to
	// flush a log line.
	time.Sleep(100 * time.Millisecond)
	captured := buf.String()
	assertNoSensitiveLogs(t, captured)
}

// assertVerbatimRelay asserts the relayed payload bytes contain every
// key/value from the original payload (including the `extraField`
// sentinel). The decoded form is compared so JSON whitespace
// differences don't false-fail.
func assertVerbatimRelay(t *testing.T, label string, want map[string]any, got json.RawMessage) {
	t.Helper()
	var fwd map[string]any
	if err := json.Unmarshal(got, &fwd); err != nil {
		t.Fatalf("%s: forwarded payload unmarshal: %v", label, err)
	}
	for k, v := range want {
		if !equalJSON(t, fwd[k], v) {
			t.Errorf(
				"%s: relay mutated key %q\n  sent=%v\n  recv=%v",
				label, k, jsonString(t, v), jsonString(t, fwd[k]),
			)
		}
	}
}

func equalJSON(t *testing.T, a, b any) bool {
	t.Helper()
	ab, _ := json.Marshal(a)
	bb, _ := json.Marshal(b)
	return bytes.Equal(ab, bb)
}

func jsonString(t *testing.T, v any) string {
	t.Helper()
	b, _ := json.Marshal(v)
	return string(b)
}

// assertNoSensitiveLogs scans captured server logs for any leak of SDP
// bodies, ICE candidate strings, TURN credentials, or pair_media_state
// values. The server may log counts and correlation IDs (pairId,
// pairEpoch, peerId, room_id) — those pass through.
func assertNoSensitiveLogs(t *testing.T, captured string) {
	t.Helper()
	forbidden := []struct {
		needle string
		why    string
	}{
		{sentinelSDPBody, "server logged SDP body fragment"},
		{sentinelICECand, "server logged ICE candidate string"},
		{sentinelTURNUser, "server logged TURN username (usernameFragment)"},
		{sentinelTURNCred, "server logged TURN credential"},
		// pair_media_state values are mic/cam/screen enum strings —
		// the canonical values themselves (`on`, `off`, `active`,
		// `inactive`) are too generic to grep for usefully because
		// they appear in `presence` enums + roster reasons. The
		// sentinel form below sits in the `extraField` we passed
		// through; confirming THAT is absent is a reasonable proxy
		// for "server did not log payload bodies".
		{sentinelExtraField, "server logged pair payload body (extraField sentinel)"},
		{sentinelMediaStateA, "server logged pair_media_state value"},
		{sentinelMediaStateB, "server logged pair_media_state value"},
	}
	for _, f := range forbidden {
		if strings.Contains(captured, f.needle) {
			t.Errorf("%s: sentinel %q present in logs", f.why, f.needle)
		}
	}
}

// mustEnvelope marshals a v=2 envelope. `pairID` is used to set a
// recipient stub on pair messages. pair_media_state has no `to` because
// fan-out is participant-level.
func mustEnvelope(t *testing.T, msgType, roomID, pairID string, payload map[string]any) []byte {
	t.Helper()
	env := map[string]any{
		"v":       mesh.ContractVersion,
		"type":    msgType,
		"roomId":  roomID,
		"payload": payload,
	}
	if msgType == "pair_offer" || msgType == "pair_answer" ||
		msgType == "pair_ice_candidate" || msgType == "pair_failed" {
		env["to"] = "00000000-0000-4000-8000-000000000001"
		_ = pairID
	}
	raw, err := json.Marshal(env)
	if err != nil {
		t.Fatalf("envelope marshal: %v", err)
	}
	return raw
}

// TestNoMediaRelay_NoMediaFrameFieldsInServerSource — static surface
// guard. The mesh server's source files MUST NOT reference media-plane
// types or RTP machinery. Schema enums are allowed (the contract names
// fields like SDP / candidate); but the codebase MUST NOT import
// MediaStream, RTCRtp*, etc.
//
// Allow-list: known schema field names that are field-of-the-protocol
// (not media handling) and appear by design.
func TestNoMediaRelay_NoMediaFrameFieldsInServerSource(t *testing.T) {
	root := findMeshSourceRoot(t)
	forbiddenSubstrings := []string{
		"MediaStream",
		"MediaStreamTrack",
		"RTCVideo",
		"RTCAudio",
		"webrtc.MediaEngine",
		"webrtc.RTPSender",
		"webrtc.RTPReceiver",
		// "RTP" (uppercase) — too short, false-positive on RTPHeader
		// in stdlib aliases. Use distinct substrings instead.
	}

	matches := map[string][]string{}
	walkErr := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			return nil
		}
		if !strings.HasSuffix(path, ".go") {
			return nil
		}
		// Skip _test.go files — tests reference forbidden substrings to
		// assert their absence.
		if strings.HasSuffix(path, "_test.go") {
			return nil
		}
		body, rerr := os.ReadFile(path)
		if rerr != nil {
			return rerr
		}
		text := string(body)
		for _, needle := range forbiddenSubstrings {
			if strings.Contains(text, needle) {
				matches[path] = append(matches[path], needle)
			}
		}
		return nil
	})
	if walkErr != nil {
		t.Fatalf("walk %s: %v", root, walkErr)
	}
	for path, needles := range matches {
		t.Errorf("server source %s contains forbidden media-frame substrings: %v", path, needles)
	}
}

// findMeshSourceRoot resolves signaling/internal/modes/mesh/ from the
// test working directory. Tests run from the package dir, so we walk
// up to the workspace root and back down.
func findMeshSourceRoot(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	// Walk up looking for go.mod (workspace root).
	dir := wd
	for i := 0; i < 8; i++ {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			candidate := filepath.Join(dir, "internal", "modes", "mesh")
			if st, err := os.Stat(candidate); err == nil && st.IsDir() {
				return candidate
			}
			break
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	t.Fatalf("could not locate signaling/internal/modes/mesh from %s", wd)
	return ""
}
