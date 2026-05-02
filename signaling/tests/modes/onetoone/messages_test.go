package tests

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	proto "webrtc-lab/signaling/internal/modes/onetoone/protocol"
)

// Stable test UUIDs. Per contract §1 / §3.1–§3.3 and the F3 fix,
// envelope requestId and payload peerId fields must be valid UUIDs.
// Using literals (rather than uuid.NewString() each run) keeps
// test failure messages readable and tests deterministic.
const (
	testPeerA    = "11111111-2222-4333-8444-555555555555"
	testPeerB    = "66666666-7777-4888-8999-aaaaaaaaaaaa"
	testReqA     = "aaaaaaaa-0000-4000-8000-000000000001"
	testReqB     = "bbbbbbbb-0000-4000-8000-000000000002"
	testReqOther = "cccccccc-0000-4000-8000-000000000003"
)

// decodeOK is a small test helper that asserts Decode succeeds and
// returns the parsed struct cast to *T.
func decodeOK[T any](t *testing.T, raw string) *T {
	t.Helper()
	d, err := proto.Decode([]byte(raw))
	if err != nil {
		t.Fatalf("Decode failed unexpectedly: %v", err)
	}
	m, ok := d.Message.(*T)
	if !ok {
		t.Fatalf("Decode produced wrong message type: %T", d.Message)
	}
	return m
}

// decodeFail asserts Decode fails with the expected ErrorCode.
func decodeFail(t *testing.T, raw string, want proto.ErrorCode) {
	t.Helper()
	_, err := proto.Decode([]byte(raw))
	if err == nil {
		t.Fatalf("Decode unexpectedly succeeded for %s", raw)
	}
	var d *proto.DecodeError
	if !errors.As(err, &d) {
		t.Fatalf("Decode returned non-DecodeError: %v", err)
	}
	if d.Code != want {
		t.Fatalf("Decode error code = %q, want %q (msg: %s)", d.Code, want, d.Message)
	}
}

// ---------------------------------------------------------------------
// Envelope-level tests
// ---------------------------------------------------------------------

func TestUnsupportedVersion(t *testing.T) {
	decodeFail(t, `{"v":2,"type":"join_room","roomId":"demo","payload":{}}`,
		proto.CodeUnsupportedVersion)
}

func TestMalformedJSON(t *testing.T) {
	decodeFail(t, `not json`, proto.CodeMalformed)
}

func TestUnknownType(t *testing.T) {
	// room_full was removed in review-pass 4; it must be rejected.
	decodeFail(t, `{"v":1,"type":"room_full","roomId":"demo","payload":{}}`,
		proto.CodeMalformed)
}

func TestStaleTypesRejected(t *testing.T) {
	stale := []string{"peer_joined", "peer_state_changed", "participant_released_media_failed"}
	for _, tp := range stale {
		raw := `{"v":1,"type":"` + tp + `","roomId":"demo","payload":{}}`
		decodeFail(t, raw, proto.CodeMalformed)
	}
}

func TestRoomIDValidation(t *testing.T) {
	cases := []struct {
		name string
		id   string
		ok   bool
	}{
		{"empty", "", false},
		{"one char", "a", true},
		{"64 char", strings.Repeat("a", 64), true},
		{"65 char", strings.Repeat("a", 65), false},
		{"space", "bad room", false},
		{"slash", "a/b", false},
		{"allowed chars", "Demo.Room_01-02", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := proto.ValidateRoomID(c.id)
			if (err == nil) != c.ok {
				t.Fatalf("ValidateRoomID(%q) ok=%v, want %v (err=%v)", c.id, err == nil, c.ok, err)
			}
		})
	}
}

// ---------------------------------------------------------------------
// join_room + join_accepted + join_rejected
// ---------------------------------------------------------------------

func TestJoinRoomRoundtrip(t *testing.T) {
	raw := `{"v":1,"type":"join_room","roomId":"demo","requestId":"d9428888-122b-11e1-b85c-61cd3cbb3210","payload":{}}`
	d, err := proto.Decode([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	if d.Envelope.Type != proto.TypeJoinRoom {
		t.Fatalf("type=%q want join_room", d.Envelope.Type)
	}
	if _, ok := d.Message.(*proto.JoinRoomPayload); !ok {
		t.Fatalf("message type = %T", d.Message)
	}
}

func TestJoinAcceptedMarshalUnmarshal(t *testing.T) {
	remote := proto.RemotePeerSnapshot{PeerID: testPeerB, MediaReadiness: proto.MediaReady}
	payload := proto.JoinAcceptedPayload{
		PeerID:         testPeerA,
		AdmissionOrder: 1,
		RoomReadiness:  proto.RoomWaitingForMedia,
		RemotePeer:     &remote,
	}
	if err := payload.Validate(); err != nil {
		t.Fatalf("validate failed: %v", err)
	}

	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	env := proto.Envelope{V: 1, Type: proto.TypeJoinAccepted, RoomID: "demo", RequestID: testReqA, Payload: body}
	raw, err := json.Marshal(env)
	if err != nil {
		t.Fatal(err)
	}

	d, err := proto.Decode(raw)
	if err != nil {
		t.Fatal(err)
	}
	p, ok := d.Message.(*proto.JoinAcceptedPayload)
	if !ok {
		t.Fatalf("wrong type: %T", d.Message)
	}
	if p.AdmissionOrder != 1 || p.RemotePeer.MediaReadiness != proto.MediaReady {
		t.Fatalf("roundtrip mismatch: %+v", p)
	}
}

func TestJoinRejectedResultEnum(t *testing.T) {
	ok := `{"v":1,"type":"join_rejected","roomId":"demo","requestId":"` + testReqA + `","payload":{"result":"join_rejected_room_full","reason":"room_full","message":"x"}}`
	decodeOK[proto.JoinRejectedPayload](t, ok)

	bad := `{"v":1,"type":"join_rejected","roomId":"demo","requestId":"` + testReqA + `","payload":{"result":"room_full","reason":"room_full","message":"x"}}`
	decodeFail(t, bad, proto.CodeMalformed)
}

// ---------------------------------------------------------------------
// media_ready / media_failed
// ---------------------------------------------------------------------

func TestMediaReadyRequiresBothAudioAndVideo(t *testing.T) {
	ok := `{"v":1,"type":"media_ready","roomId":"demo","payload":{"mediaCapabilities":{"audio":true,"video":true}}}`
	decodeOK[proto.MediaReadyPayload](t, ok)

	noAudio := `{"v":1,"type":"media_ready","roomId":"demo","payload":{"mediaCapabilities":{"audio":false,"video":true}}}`
	decodeFail(t, noAudio, proto.CodeUnsupportedMediaCapability)

	noVideo := `{"v":1,"type":"media_ready","roomId":"demo","payload":{"mediaCapabilities":{"audio":true,"video":false}}}`
	decodeFail(t, noVideo, proto.CodeUnsupportedMediaCapability)
}

func TestMediaFailedReasons(t *testing.T) {
	for _, reason := range []string{"permission_denied", "device_not_found", "device_in_use", "other"} {
		raw := `{"v":1,"type":"media_failed","roomId":"demo","payload":{"reason":"` + reason + `"}}`
		decodeOK[proto.MediaFailedPayload](t, raw)
	}
	decodeFail(t,
		`{"v":1,"type":"media_failed","roomId":"demo","payload":{"reason":"timeout"}}`,
		proto.CodeMalformed)
}

// ---------------------------------------------------------------------
// peer_presence_changed
// ---------------------------------------------------------------------

func TestPeerPresenceChangedEnums(t *testing.T) {
	ok := `{"v":1,"type":"peer_presence_changed","roomId":"demo","payload":{"subjectPeerId":"` + testPeerB + `","admissionOrder":2,"presence":"pending-media","reason":"admitted"}}`
	decodeOK[proto.PeerPresenceChangedPayload](t, ok)

	bad := `{"v":1,"type":"peer_presence_changed","roomId":"demo","payload":{"subjectPeerId":"` + testPeerB + `","admissionOrder":2,"presence":"joined","reason":"admitted"}}`
	decodeFail(t, bad, proto.CodeMalformed)
}

// ---------------------------------------------------------------------
// ready_for_offer
// ---------------------------------------------------------------------

func TestReadyForOfferRoles(t *testing.T) {
	ok := `{"v":1,"type":"ready_for_offer","roomId":"demo","to":"` + testPeerA + `","payload":{"role":"offerer","remotePeer":{"peerId":"` + testPeerB + `","admissionOrder":2},"iceServers":[{"urls":["stun:stun.l.google.com:19302"]}]}}`
	decodeOK[proto.ReadyForOfferPayload](t, ok)

	badRole := `{"v":1,"type":"ready_for_offer","roomId":"demo","to":"` + testPeerA + `","payload":{"role":"initiator","remotePeer":{"peerId":"` + testPeerB + `","admissionOrder":2},"iceServers":[]}}`
	decodeFail(t, badRole, proto.CodeMalformed)
}

// ---------------------------------------------------------------------
// offer / answer
// ---------------------------------------------------------------------

func TestOfferAnswerSDPType(t *testing.T) {
	okOffer := `{"v":1,"type":"offer","roomId":"demo","payload":{"sdp":{"type":"offer","sdp":"v=0\r\n"}}}`
	decodeOK[proto.OfferPayload](t, okOffer)

	badOffer := `{"v":1,"type":"offer","roomId":"demo","payload":{"sdp":{"type":"answer","sdp":"v=0\r\n"}}}`
	decodeFail(t, badOffer, proto.CodeMalformed)

	okAnswer := `{"v":1,"type":"answer","roomId":"demo","payload":{"sdp":{"type":"answer","sdp":"v=0\r\n"}}}`
	decodeOK[proto.AnswerPayload](t, okAnswer)

	badAnswer := `{"v":1,"type":"answer","roomId":"demo","payload":{"sdp":{"type":"offer","sdp":"v=0\r\n"}}}`
	decodeFail(t, badAnswer, proto.CodeMalformed)
}

// ---------------------------------------------------------------------
// ice_candidate
// ---------------------------------------------------------------------

func TestIceCandidateAcceptsNull(t *testing.T) {
	raw := `{"v":1,"type":"ice_candidate","roomId":"demo","payload":{"candidate":null}}`
	m := decodeOK[proto.IceCandidatePayload](t, raw)
	if m.Candidate != nil {
		t.Fatalf("expected nil candidate for end-of-candidates")
	}
}

func TestIceCandidateAcceptsPopulated(t *testing.T) {
	raw := `{"v":1,"type":"ice_candidate","roomId":"demo","payload":{"candidate":{"candidate":"candidate:1 1 UDP ...","sdpMid":"0","sdpMLineIndex":0,"usernameFragment":"ufrag"}}}`
	m := decodeOK[proto.IceCandidatePayload](t, raw)
	if m.Candidate == nil || m.Candidate.Candidate == "" {
		t.Fatalf("expected populated candidate, got %+v", m.Candidate)
	}
}

func TestIceCandidateRejectsEmptyString(t *testing.T) {
	raw := `{"v":1,"type":"ice_candidate","roomId":"demo","payload":{"candidate":{"candidate":"","sdpMid":"0","sdpMLineIndex":0}}}`
	decodeFail(t, raw, proto.CodeMalformed)
}

func TestIceCandidateRejectsMissingKey(t *testing.T) {
	raw := `{"v":1,"type":"ice_candidate","roomId":"demo","payload":{}}`
	decodeFail(t, raw, proto.CodeMalformed)
}

// ---------------------------------------------------------------------
// media_state
// ---------------------------------------------------------------------

func TestMediaStateRequiresAllFields(t *testing.T) {
	full := `{"v":1,"type":"media_state","roomId":"demo","payload":{"microphone":"off","camera":"on","screenShare":"inactive"}}`
	decodeOK[proto.MediaStatePayload](t, full)

	bad := `{"v":1,"type":"media_state","roomId":"demo","payload":{"microphone":"muted","camera":"on","screenShare":"inactive"}}`
	decodeFail(t, bad, proto.CodeMalformed)
}

// ---------------------------------------------------------------------
// peer_left / participant_released / leave_room / error
// ---------------------------------------------------------------------

func TestPeerLeftReasonEnum(t *testing.T) {
	ok := `{"v":1,"type":"peer_left","roomId":"demo","payload":{"peerId":"` + testPeerB + `","reason":"disconnect"}}`
	decodeOK[proto.PeerLeftPayload](t, ok)

	bad := `{"v":1,"type":"peer_left","roomId":"demo","payload":{"peerId":"` + testPeerB + `","reason":"media_failed"}}`
	decodeFail(t, bad, proto.CodeMalformed)
}

func TestParticipantReleasedResultEnum(t *testing.T) {
	ok := `{"v":1,"type":"participant_released","roomId":"demo","payload":{"result":"participant_released_disconnect","reason":"disconnect"}}`
	decodeOK[proto.ParticipantReleasedPayload](t, ok)

	bad := `{"v":1,"type":"participant_released","roomId":"demo","payload":{"result":"participant_released_other","reason":"media_failed"}}`
	decodeFail(t, bad, proto.CodeMalformed)
}

func TestLeaveRoomEmptyPayload(t *testing.T) {
	raw := `{"v":1,"type":"leave_room","roomId":"demo","payload":{}}`
	decodeOK[proto.LeaveRoomPayload](t, raw)
}

// F3 regression — validateEnvelope rules at the Decode boundary.
//
// These tests drive Decode (public API) so they exercise the
// envelope validator the same way the /ws handler does. They pin
// Phase-3 inbound-surface rules so later phases that extend
// validateEnvelope can't regress Phase 3 behavior.

func TestLeaveRoomRequiresRoomId(t *testing.T) {
	// Missing roomId → malformed.
	decodeFail(t, `{"v":1,"type":"leave_room","payload":{}}`,
		proto.CodeMalformed)

	// Well-formed envelope → accepted.
	decodeOK[proto.LeaveRoomPayload](t,
		`{"v":1,"type":"leave_room","roomId":"demo","payload":{}}`)

	// Present-but-malformed roomId → malformed.
	decodeFail(t, `{"v":1,"type":"leave_room","roomId":"bad room!","payload":{}}`,
		proto.CodeMalformed)
}

func TestEnvelopeFromToFieldsRequireUUIDWhenPresent(t *testing.T) {
	// Universal rule: any envelope with a non-UUID `from` or `to`
	// is malformed regardless of message type. We use peer_left
	// (Phase-3 type, no per-type envelope rules beyond roomId) to
	// probe this.
	badFrom := `{"v":1,"type":"peer_left","roomId":"demo","from":"not-a-uuid","payload":{"peerId":"` + testPeerB + `","reason":"disconnect"}}`
	decodeFail(t, badFrom, proto.CodeMalformed)

	badTo := `{"v":1,"type":"peer_left","roomId":"demo","to":"not-a-uuid","payload":{"peerId":"` + testPeerB + `","reason":"disconnect"}}`
	decodeFail(t, badTo, proto.CodeMalformed)

	okFrom := `{"v":1,"type":"peer_left","roomId":"demo","from":"` + testPeerA + `","payload":{"peerId":"` + testPeerB + `","reason":"disconnect"}}`
	decodeOK[proto.PeerLeftPayload](t, okFrom)
}

func TestJoinRoomRequiresRequestId(t *testing.T) {
	// Missing requestId on join_room → malformed.
	decodeFail(t,
		`{"v":1,"type":"join_room","roomId":"demo","payload":{}}`,
		proto.CodeMalformed)

	// Non-UUID requestId → malformed (universal rule).
	decodeFail(t,
		`{"v":1,"type":"join_room","roomId":"demo","requestId":"not-uuid","payload":{}}`,
		proto.CodeMalformed)

	// Valid UUID requestId → accepted.
	decodeOK[proto.JoinRoomPayload](t,
		`{"v":1,"type":"join_room","roomId":"demo","requestId":"`+testReqA+`","payload":{}}`)
}

func TestErrorCodeEnum(t *testing.T) {
	codes := []proto.ErrorCode{
		proto.CodeAlreadyJoined, proto.CodeUnexpectedMediaReady,
		proto.CodeUnsupportedMediaCapability, proto.CodeUnexpectedOffer,
		proto.CodeUnexpectedAnswer, proto.CodeNotInRoom, proto.CodeMalformed,
		proto.CodeUnsupportedVersion, proto.CodeInternalError,
	}
	for _, c := range codes {
		raw := `{"v":1,"type":"error","payload":{"code":"` + string(c) + `","message":"x"}}`
		decodeOK[proto.ErrorPayload](t, raw)
	}

	// room_full and invalid_room_id are NOT error codes — they are
	// join_rejected results.
	for _, bad := range []string{"room_full", "invalid_room_id"} {
		raw := `{"v":1,"type":"error","payload":{"code":"` + bad + `","message":"x"}}`
		decodeFail(t, raw, proto.CodeMalformed)
	}
}
