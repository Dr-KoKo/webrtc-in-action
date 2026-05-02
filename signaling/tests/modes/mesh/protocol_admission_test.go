// Admission-family round-trip + invariant tests (contract §3.1–§3.3,
// §3.8, §3.17, §3.18).

package mesh_test

import (
	"encoding/json"
	"strings"
	"testing"

	protocol "webrtc-lab/signaling/internal/modes/mesh/protocol"
)

func TestJoinAcceptedRoundTrip(t *testing.T) {
	raw := []byte(`{
      "v": 2,
      "type": "join_accepted",
      "roomId": "mesh-demo",
      "requestId": "deadbeef-0000-4000-8000-000000000001",
      "payload": {
        "peerId": "11111111-2222-4333-8444-555555555555",
        "admissionIndex": 3,
        "iceServers": [{ "urls": ["stun:stun.l.google.com:19302"] }]
      }
    }`)
	d, err := protocol.DecodeEnvelope(raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	p, ok := d.Message.(*protocol.JoinAcceptedPayload)
	if !ok {
		t.Fatalf("payload type = %T, want *JoinAcceptedPayload", d.Message)
	}
	if p.AdmissionIndex != 3 {
		t.Fatalf("admissionIndex = %d, want 3", p.AdmissionIndex)
	}
}

func TestJoinRejectedAcceptsRoomFull(t *testing.T) {
	payload, _ := json.Marshal(protocol.JoinRejectedPayload{
		Result:  protocol.JoinRejectedRoomFull,
		Reason:  protocol.ReasonRoomFull,
		Message: "Room 'demo' already has 4 reserved participants.",
	})
	if err := protocol.Validate(protocol.TypeJoinRejected, payload); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestJoinRejectedAcceptsInvalidRoom(t *testing.T) {
	payload, _ := json.Marshal(protocol.JoinRejectedPayload{
		Result:  protocol.JoinRejectedInvalidRoom,
		Reason:  protocol.ReasonInvalidRoomID,
		Message: "Room ID must match ^[A-Za-z0-9._-]{1,64}$.",
	})
	if err := protocol.Validate(protocol.TypeJoinRejected, payload); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

// TestJoinRejectedRejectsUnsupportedVersion locks in the C17 fix:
// `join_rejected_unsupported_version` is NOT a valid result enum value
// — version mismatch flows through `error { code: unsupported_version }`.
func TestJoinRejectedRejectsUnsupportedVersion(t *testing.T) {
	payload := []byte(`{"result":"join_rejected_unsupported_version","reason":"room_full","message":"x"}`)
	err := protocol.Validate(protocol.TypeJoinRejected, payload)
	if err == nil {
		t.Fatal("expected join_rejected_unsupported_version to be rejected")
	}
	var perr *protocol.ProtocolError
	if !asProtocolError(err, &perr) || perr.Code != protocol.CodeMalformed {
		t.Fatalf("got %v, want malformed protocol error", err)
	}
	if !strings.Contains(perr.Message, "join_rejected.result") {
		t.Errorf("message should mention join_rejected.result; got %q", perr.Message)
	}
}

// TestJoinRejectedResultEnumIsExactlyTwo asserts the (closed) result
// set has exactly the contract's two values.
func TestJoinRejectedResultEnumIsExactlyTwo(t *testing.T) {
	cases := []string{
		"join_rejected_room_full",
		"join_rejected_invalid_room",
	}
	for _, ok := range cases {
		payload := []byte(`{"result":"` + ok + `","reason":"room_full","message":"x"}`)
		// reason may not match perfectly but result enum is what we test.
		if ok == "join_rejected_invalid_room" {
			payload = []byte(`{"result":"` + ok + `","reason":"invalid_room_id","message":"x"}`)
		}
		if err := protocol.Validate(protocol.TypeJoinRejected, payload); err != nil {
			t.Errorf("expected %q accepted, got %v", ok, err)
		}
	}
	bad := []string{
		"join_rejected_unsupported_version",
		"room_full",
		"invalid_room_id",
		"",
	}
	for _, bv := range bad {
		payload := []byte(`{"result":"` + bv + `","reason":"room_full","message":"x"}`)
		if err := protocol.Validate(protocol.TypeJoinRejected, payload); err == nil {
			t.Errorf("expected %q rejected, got nil", bv)
		}
	}
}

func TestPeerLeftRoundTrip(t *testing.T) {
	payload, _ := json.Marshal(protocol.PeerLeftPayload{
		PeerID: "11111111-2222-4333-8444-555555555555",
		Reason: protocol.PeerLeftDisconnect,
	})
	if err := protocol.Validate(protocol.TypePeerLeft, payload); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestParticipantReleasedRoundTrip(t *testing.T) {
	payload, _ := json.Marshal(protocol.ParticipantReleasedPayload{
		Result: protocol.ParticipantReleasedMediaFailed,
		Reason: protocol.ReleasedReasonMediaFailed,
		Detail: "camera_permission_denied",
	})
	if err := protocol.Validate(protocol.TypeParticipantReleased, payload); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestLeaveRoomEmptyPayloadAccepted(t *testing.T) {
	if err := protocol.Validate(protocol.TypeLeaveRoom, []byte(`{}`)); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}
