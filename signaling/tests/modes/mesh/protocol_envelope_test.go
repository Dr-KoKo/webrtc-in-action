// Envelope-level decode tests covering version-mismatch, unknown-type,
// missing required fields, and the ErrorCode enum invariant.

package mesh_test

import (
	"errors"
	"testing"

	protocol "webrtc-lab/signaling/internal/modes/mesh/protocol"
)

// helper: unwrap to *protocol.ProtocolError or fail.
func mustProtocolErr(t *testing.T, err error) *protocol.ProtocolError {
	t.Helper()
	var perr *protocol.ProtocolError
	if !errors.As(err, &perr) {
		t.Fatalf("expected *protocol.ProtocolError; got %T (%v)", err, err)
	}
	return perr
}

func TestDecodeEnvelopeRejectsV1(t *testing.T) {
	raw := []byte(`{"v":1,"type":"join_room","roomId":"demo","requestId":"deadbeef-0000-4000-8000-000000000001","payload":{}}`)
	_, err := protocol.DecodeEnvelope(raw)
	perr := mustProtocolErr(t, err)
	if perr.Code != protocol.CodeUnsupportedVersion {
		t.Fatalf("code = %q, want %q", perr.Code, protocol.CodeUnsupportedVersion)
	}
}

func TestDecodeEnvelopeRejectsV3(t *testing.T) {
	raw := []byte(`{"v":3,"type":"join_room","roomId":"demo","requestId":"deadbeef-0000-4000-8000-000000000001","payload":{}}`)
	_, err := protocol.DecodeEnvelope(raw)
	perr := mustProtocolErr(t, err)
	if perr.Code != protocol.CodeUnsupportedVersion {
		t.Fatalf("code = %q, want %q", perr.Code, protocol.CodeUnsupportedVersion)
	}
}

func TestDecodeEnvelopeRejectsUnknownType(t *testing.T) {
	raw := []byte(`{"v":2,"type":"chat_message","roomId":"demo","payload":{}}`)
	_, err := protocol.DecodeEnvelope(raw)
	perr := mustProtocolErr(t, err)
	if perr.Code != protocol.CodeMalformed {
		t.Fatalf("code = %q, want %q", perr.Code, protocol.CodeMalformed)
	}
}

func TestDecodeEnvelopeRejectsBadJSON(t *testing.T) {
	raw := []byte(`{not-json`)
	_, err := protocol.DecodeEnvelope(raw)
	perr := mustProtocolErr(t, err)
	if perr.Code != protocol.CodeMalformed {
		t.Fatalf("code = %q, want %q", perr.Code, protocol.CodeMalformed)
	}
}

func TestDecodeEnvelopeRejectsJoinRoomMissingRequestID(t *testing.T) {
	raw := []byte(`{"v":2,"type":"join_room","roomId":"demo","payload":{}}`)
	_, err := protocol.DecodeEnvelope(raw)
	perr := mustProtocolErr(t, err)
	if perr.Code != protocol.CodeMalformed {
		t.Fatalf("code = %q, want %q", perr.Code, protocol.CodeMalformed)
	}
}

func TestDecodeEnvelopeRejectsJoinRoomMissingRoomID(t *testing.T) {
	raw := []byte(`{"v":2,"type":"join_room","requestId":"deadbeef-0000-4000-8000-000000000001","payload":{}}`)
	_, err := protocol.DecodeEnvelope(raw)
	perr := mustProtocolErr(t, err)
	if perr.Code != protocol.CodeMalformed {
		t.Fatalf("code = %q, want %q", perr.Code, protocol.CodeMalformed)
	}
}

func TestDecodeEnvelopeAcceptsValidJoinRoom(t *testing.T) {
	raw := []byte(`{"v":2,"type":"join_room","roomId":"demo","requestId":"deadbeef-0000-4000-8000-000000000001","payload":{}}`)
	d, err := protocol.DecodeEnvelope(raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if d.Envelope.Type != protocol.TypeJoinRoom {
		t.Fatalf("type = %q, want %q", d.Envelope.Type, protocol.TypeJoinRoom)
	}
	if d.Envelope.RoomID != "demo" {
		t.Fatalf("roomId = %q, want %q", d.Envelope.RoomID, "demo")
	}
}

// TestErrorCodeEnumMatchesContract — the §3.19 closed set MUST stay in
// sync. The forbidden codes (`room_full`, `invalid_room_id`,
// `screen_share_busy`) are absent compile-time; this assertion catches
// accidental additions.
func TestErrorCodeEnumMatchesContract(t *testing.T) {
	want := map[protocol.ErrorCode]struct{}{
		protocol.CodeAlreadyJoined:              {},
		protocol.CodeUnsupportedVersion:         {},
		protocol.CodeMalformed:                  {},
		protocol.CodeNotInRoom:                  {},
		protocol.CodeUnexpectedMediaReady:       {},
		protocol.CodeUnsupportedMediaCapability: {},
		protocol.CodeUnexpectedOffer:            {},
		protocol.CodeUnexpectedAnswer:           {},
		protocol.CodeStalePairEpoch:             {},
		protocol.CodeStaleRosterUpdate:          {},
		protocol.CodeInternalError:              {},
	}
	if len(protocol.AllErrorCodes) != len(want) {
		t.Fatalf("AllErrorCodes len = %d, want %d", len(protocol.AllErrorCodes), len(want))
	}
	for _, c := range protocol.AllErrorCodes {
		if _, ok := want[c]; !ok {
			t.Errorf("AllErrorCodes contains unexpected code %q", c)
		}
	}
}

// TestRoomFullIsNotAMessageType locks in that the legacy bare
// `room_full` envelope type was not re-introduced.
func TestRoomFullIsNotAMessageType(t *testing.T) {
	for _, t2 := range protocol.AllTypes {
		if string(t2) == "room_full" {
			t.Fatalf("'room_full' must not be a registered MessageType")
		}
	}
}
