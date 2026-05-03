// T073 — server-side fan-out for `pair_media_state` (contract §3.13).
//
// Drives the in-process /ws/mesh handler through admit + media-ready
// for N participants and asserts:
//
//   - One inbound `pair_media_state` from the sender produces exactly
//     N − 1 outbound envelopes (N=2,3,4 covered).
//   - The sender does NOT receive its own fan-out.
//   - Payload bytes are forwarded verbatim — unknown / extra fields
//     pass through (additive evolution rule §7) and the three required
//     fields are unchanged.
//   - The relay does not require / does not check `pairId` or
//     `pairEpoch` (the message carries neither). A payload that
//     includes a stray `pairEpoch` is forwarded (Go default unmarshal
//     ignores unknown keys at decode; the `Payload json.RawMessage` is
//     passed through, so the extra key reaches every recipient).
//   - A sender that is not in the room (cc.peerID == "") is rejected
//     with `error not_in_room`; no fan-out occurs.
//   - The server's structured log lines for the fan-out event include
//     ONLY counts + correlation IDs — no mic/cam/screen values
//     (NFR-003 + plan-prompt: "do not log mic/cam/screen values").
//   - The server does NOT relay any media bytes — the only thing on
//     the wire for this message family is the metadata envelope.
//
// Verify with:
//   go test ./tests/modes/mesh/mesh_media_state_fanout_test.go
//
// (Path note: the active mesh signaling package lives under
// `internal/modes/mesh` — see CLAUDE.md layout. The task scaffold
// references the historical `internal/mesh` path; the live code +
// tests use `modes/mesh` so the new test file lives next to its peers.)

package mesh_test

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"webrtc-lab/signaling/internal/modes/mesh"

	protocol "webrtc-lab/signaling/internal/modes/mesh/protocol"
)

// admitNAndReachMediaReady admits exactly n participants into a fresh
// mesh room and walks each through media-ready in admission order. It
// returns the conns; pre-existing pair instructions emitted along the
// way are drained so callers' assertions only see the post-setup
// frames they're interested in.
func admitNAndReachMediaReady(
	t *testing.T,
	ts *httptest.Server,
	ctx context.Context,
	roomID string,
	n int,
) []*websocket.Conn {
	t.Helper()
	if n < 2 || n > 4 {
		t.Fatalf("admitNAndReachMediaReady: n must be 2..4 (got %d)", n)
	}
	conns := make([]*websocket.Conn, 0, n)
	for i := 0; i < n; i++ {
		c, _, _ := joinAndExpectAccepted(t, ts, ctx, roomID)
		_ = drainMeshFrames(t, c, ctx, 2) // snapshot + own joined update
		conns = append(conns, c)
	}
	// Earlier conns each received a `joined` roster update for every
	// later joiner.
	for i := 0; i < n; i++ {
		drainOnePerJoiner(t, conns[i], ctx, n-1-i)
	}
	// Walk media-ready transitions in admission order. For each
	// transition we drain the post-event frames in the precise order
	// the server emits them so a later transition's frames don't pile
	// up behind unread instructions (which `readMeshFrameOfType`
	// would silently skip past while looking for a roster_update).
	//
	// When conn[i] becomes media-ready:
	//   1. server broadcasts roster_update to ALL conns (1 each)
	//   2. server emits pair_negotiation_instruction for each NEW pair
	//      (j+1, i+1) for j < i:
	//        - conn[j] receives 1 (offerer)
	//        - conn[i] receives i (answerer of every prior peer)
	for i := 0; i < n; i++ {
		sendMediaReady(t, conns[i], ctx, roomID)
		drainAllRosterUpdatesForMediaReady(t, conns, ctx)
		for j := 0; j < i; j++ {
			readNPairInstructions(t, conns[j], ctx, 1)
		}
		if i > 0 {
			readNPairInstructions(t, conns[i], ctx, i)
		}
	}
	return conns
}

// buildPairMediaStateEnvelope marshals a v=2 pair_media_state envelope
// with the supplied triple. `extras` allows the caller to inject extra
// keys (e.g. a stray `pairEpoch`) into the payload to exercise the
// "ignore unknown" / additive-evolution path.
func buildPairMediaStateEnvelope(
	t *testing.T,
	roomID string,
	mic protocol.MicState,
	cam protocol.CameraState,
	screen protocol.ScreenShareState,
	extras map[string]any,
) []byte {
	t.Helper()
	payload := map[string]any{
		"microphone":  mic,
		"camera":      cam,
		"screenShare": screen,
	}
	for k, v := range extras {
		payload[k] = v
	}
	env := map[string]any{
		"v":       protocol.ContractVersion,
		"type":    "pair_media_state",
		"roomId":  roomID,
		"payload": payload,
	}
	raw, err := json.Marshal(env)
	if err != nil {
		t.Fatalf("env marshal: %v", err)
	}
	return raw
}

// readPairMediaStateEnvelope reads the next frame and asserts type =
// pair_media_state. Returns the envelope + decoded payload.
func readPairMediaStateEnvelope(
	t *testing.T,
	conn *websocket.Conn,
	ctx context.Context,
) (protocol.Envelope, protocol.PairMediaStatePayload, map[string]any) {
	t.Helper()
	env := readMeshFrameOfType(t, conn, ctx, protocol.TypePairMediaState)
	var typed protocol.PairMediaStatePayload
	if err := json.Unmarshal(env.Payload, &typed); err != nil {
		t.Fatalf("typed payload unmarshal: %v", err)
	}
	var raw map[string]any
	if err := json.Unmarshal(env.Payload, &raw); err != nil {
		t.Fatalf("raw payload unmarshal: %v", err)
	}
	return env, typed, raw
}

// TestPairMediaStateFanOutN2 — N=2: one inbound produces 1 outbound.
func TestPairMediaStateFanOutN2(t *testing.T) {
	logger, buf := captureLogger()
	h := mesh.NewHandler(logger, defaultModeConfig())
	ts := httptest.NewServer(h)
	defer ts.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conns := admitNAndReachMediaReady(t, ts, ctx, "ms2", 2)
	for _, c := range conns {
		defer c.CloseNow()
	}

	raw := buildPairMediaStateEnvelope(t, "ms2", protocol.MicOff, protocol.CamOn, protocol.ScreenInactive, nil)
	if err := conns[0].Write(ctx, websocket.MessageText, raw); err != nil {
		t.Fatalf("A write pair_media_state failed: %v", err)
	}

	env, typed, _ := readPairMediaStateEnvelope(t, conns[1], ctx)
	if env.From == "" {
		t.Fatalf("relayed envelope missing `from`")
	}
	if typed.Microphone != protocol.MicOff || typed.Camera != protocol.CamOn || typed.ScreenShare != protocol.ScreenInactive {
		t.Fatalf("payload values mutated: %+v", typed)
	}
	// Sender (A) must NOT receive its own fan-out. Only the sender
	// gets the no-further-frame check — calling it on the recipient
	// would require a 200 ms read whose ctx-expiry causes
	// coder/websocket to close the recipient's WS, which then
	// triggers a `presence:left` broadcast back to the sender (a
	// false positive on the next assertion).
	expectNoFurtherFrame(t, conns[0])

	// Server logs must NOT include mic/cam/screen values (only counts +
	// correlation IDs).
	logs := buf.String()
	for _, banned := range []string{`"mic":"off"`, `"camera":"on"`, `"screenShare":"inactive"`, `"microphone":"off"`} {
		if strings.Contains(logs, banned) {
			t.Fatalf("server log leaked media-state value %q:\n%s", banned, logs)
		}
	}
	if !strings.Contains(logs, "mesh_pair_media_state_fanout") {
		t.Fatalf("server log missing fan-out event line; got:\n%s", logs)
	}
	if !strings.Contains(logs, `"delivered":1`) {
		t.Fatalf("server log missing delivered=1; got:\n%s", logs)
	}
}

// TestPairMediaStateFanOutN3 — N=3: one inbound produces 2 outbound.
func TestPairMediaStateFanOutN3(t *testing.T) {
	h := mesh.NewHandler(silentLogger(), defaultModeConfig())
	ts := httptest.NewServer(h)
	defer ts.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()

	conns := admitNAndReachMediaReady(t, ts, ctx, "ms3", 3)
	for _, c := range conns {
		defer c.CloseNow()
	}

	raw := buildPairMediaStateEnvelope(t, "ms3", protocol.MicOn, protocol.CamOff, protocol.ScreenInactive, nil)
	if err := conns[0].Write(ctx, websocket.MessageText, raw); err != nil {
		t.Fatalf("A write pair_media_state failed: %v", err)
	}

	for i := 1; i < 3; i++ {
		env, typed, _ := readPairMediaStateEnvelope(t, conns[i], ctx)
		if env.From == "" {
			t.Fatalf("conn[%d] relayed envelope missing `from`", i)
		}
		if typed.Microphone != protocol.MicOn || typed.Camera != protocol.CamOff || typed.ScreenShare != protocol.ScreenInactive {
			t.Fatalf("conn[%d] payload mutated: %+v", i, typed)
		}
	}
	expectNoFurtherFrame(t, conns[0])
}

// TestPairMediaStateFanOutN4 — N=4: one inbound produces 3 outbound.
func TestPairMediaStateFanOutN4(t *testing.T) {
	h := mesh.NewHandler(silentLogger(), defaultModeConfig())
	ts := httptest.NewServer(h)
	defer ts.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	conns := admitNAndReachMediaReady(t, ts, ctx, "ms4", 4)
	for _, c := range conns {
		defer c.CloseNow()
	}

	raw := buildPairMediaStateEnvelope(t, "ms4", protocol.MicOff, protocol.CamOff, protocol.ScreenInactive, nil)
	if err := conns[0].Write(ctx, websocket.MessageText, raw); err != nil {
		t.Fatalf("A write pair_media_state failed: %v", err)
	}

	for i := 1; i < 4; i++ {
		env, typed, _ := readPairMediaStateEnvelope(t, conns[i], ctx)
		if env.From == "" {
			t.Fatalf("conn[%d] relayed envelope missing `from`", i)
		}
		if typed.Microphone != protocol.MicOff || typed.Camera != protocol.CamOff || typed.ScreenShare != protocol.ScreenInactive {
			t.Fatalf("conn[%d] payload mutated: %+v", i, typed)
		}
	}
	expectNoFurtherFrame(t, conns[0])
}

// TestPairMediaStateFanOutPayloadBytesUnchanged — extra/unknown fields
// in the payload (e.g. a stray `pairEpoch`) are forwarded verbatim
// (additive evolution rule §7); the message remains
// participant-level metadata with no pairEpoch validation.
func TestPairMediaStateFanOutPayloadBytesUnchanged(t *testing.T) {
	h := mesh.NewHandler(silentLogger(), defaultModeConfig())
	ts := httptest.NewServer(h)
	defer ts.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conns := admitNAndReachMediaReady(t, ts, ctx, "msextras", 2)
	for _, c := range conns {
		defer c.CloseNow()
	}

	extras := map[string]any{
		"pairEpoch":   42,
		"extraField":  "must-pass-through",
		"clientHints": map[string]any{"build": "test"},
	}
	raw := buildPairMediaStateEnvelope(t, "msextras", protocol.MicOn, protocol.CamOn, protocol.ScreenInactive, extras)
	if err := conns[0].Write(ctx, websocket.MessageText, raw); err != nil {
		t.Fatalf("A write pair_media_state failed: %v", err)
	}

	_, typed, rawPayload := readPairMediaStateEnvelope(t, conns[1], ctx)
	if typed.Microphone != protocol.MicOn || typed.Camera != protocol.CamOn || typed.ScreenShare != protocol.ScreenInactive {
		t.Fatalf("relayed required fields mutated: %+v", typed)
	}
	if rawPayload["extraField"] != "must-pass-through" {
		t.Fatalf("server mutated payload — extraField missing or changed: %v", rawPayload["extraField"])
	}
	// Extra `pairEpoch` is preserved (proves the relay didn't strip it
	// and didn't run any pair-epoch validation).
	if got, ok := rawPayload["pairEpoch"]; !ok {
		t.Fatalf("server stripped pairEpoch from passthrough: %v", rawPayload)
	} else {
		// JSON numbers decode to float64.
		if f, _ := got.(float64); f != 42 {
			t.Fatalf("server mutated pairEpoch passthrough: got %v want 42", got)
		}
	}
}

// TestPairMediaStateNotInRoomRejected — a fresh, never-joined client
// sending pair_media_state receives `error not_in_room` and no
// fan-out occurs.
func TestPairMediaStateNotInRoomRejected(t *testing.T) {
	h := mesh.NewHandler(silentLogger(), defaultModeConfig())
	ts := httptest.NewServer(h)
	defer ts.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Pre-existing room with two media-ready members.
	conns := admitNAndReachMediaReady(t, ts, ctx, "msrej", 2)
	for _, c := range conns {
		defer c.CloseNow()
	}

	// A fresh client that never joined the room sends a message.
	stranger := dialMesh(t, ts, ctx)
	defer stranger.CloseNow()
	raw := buildPairMediaStateEnvelope(t, "msrej", protocol.MicOff, protocol.CamOn, protocol.ScreenInactive, nil)
	if err := stranger.Write(ctx, websocket.MessageText, raw); err != nil {
		t.Fatalf("stranger write failed: %v", err)
	}

	got := readMeshFrameOfType(t, stranger, ctx, protocol.TypeError)
	var ep protocol.ErrorPayload
	if err := json.Unmarshal(got.Payload, &ep); err != nil {
		t.Fatalf("error payload unmarshal: %v", err)
	}
	if ep.Code != protocol.CodeNotInRoom {
		t.Fatalf("error.code = %q; want not_in_room", ep.Code)
	}
	// Only check one room participant for "no fan-out". Checking both
	// risks the first conn's 200 ms read-deadline closing it and
	// firing a `presence:left` broadcast at the second.
	expectNoFurtherFrame(t, conns[0])
}

// TestPairMediaStateMalformedPayloadRejected — a payload missing one
// of the three required fields, or with an out-of-enum value, is
// rejected with `error malformed` and no fan-out occurs.
func TestPairMediaStateMalformedPayloadRejected(t *testing.T) {
	h := mesh.NewHandler(silentLogger(), defaultModeConfig())
	ts := httptest.NewServer(h)
	defer ts.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conns := admitNAndReachMediaReady(t, ts, ctx, "msbad", 2)
	for _, c := range conns {
		defer c.CloseNow()
	}

	// Out-of-enum microphone value → `malformed`.
	bad := []byte(`{"v":2,"type":"pair_media_state","roomId":"msbad","payload":{"microphone":"bogus","camera":"on","screenShare":"inactive"}}`)
	if err := conns[0].Write(ctx, websocket.MessageText, bad); err != nil {
		t.Fatalf("A write malformed pair_media_state failed: %v", err)
	}
	got := readMeshFrameOfType(t, conns[0], ctx, protocol.TypeError)
	var ep protocol.ErrorPayload
	if err := json.Unmarshal(got.Payload, &ep); err != nil {
		t.Fatalf("error payload unmarshal: %v", err)
	}
	if ep.Code != protocol.CodeMalformed {
		t.Fatalf("error.code = %q; want malformed", ep.Code)
	}
	expectNoFurtherFrame(t, conns[1])
}

// TestPairMediaStateServerNeverRelaysMediaBytes — the only frame sent
// on the wire for this family is the metadata envelope. The server
// never relays media bytes (FR-024 / FR-091). Asserts that after the
// metadata fan-out completes, no additional frame leaks to a
// recipient (so the transport carried exactly one frame per
// recipient: the metadata envelope, nothing more, nothing for media
// payload).
func TestPairMediaStateServerNeverRelaysMediaBytes(t *testing.T) {
	h := mesh.NewHandler(silentLogger(), defaultModeConfig())
	ts := httptest.NewServer(h)
	defer ts.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conns := admitNAndReachMediaReady(t, ts, ctx, "msmedia", 2)
	for _, c := range conns {
		defer c.CloseNow()
	}

	raw := buildPairMediaStateEnvelope(t, "msmedia", protocol.MicOff, protocol.CamOn, protocol.ScreenInactive, nil)
	if err := conns[0].Write(ctx, websocket.MessageText, raw); err != nil {
		t.Fatalf("A write pair_media_state failed: %v", err)
	}

	// Recipient gets exactly one metadata envelope; the sender stays
	// silent. (We only test one side's "no further frame" — see the
	// note in TestPairMediaStateFanOutN2 about the 200 ms read-
	// deadline race.)
	_, _, _ = readPairMediaStateEnvelope(t, conns[1], ctx)
	expectNoFurtherFrame(t, conns[0])
}
