// Envelope-level decode tests covering version-mismatch, unknown-type,
// missing required fields, and the ErrorCode enum invariant.

package mesh_test

import (
	"errors"
	"testing"

	"webrtc-lab/signaling/internal/mesh"
)

// helper: unwrap to *mesh.ProtocolError or fail.
func mustProtocolErr(t *testing.T, err error) *mesh.ProtocolError {
	t.Helper()
	var perr *mesh.ProtocolError
	if !errors.As(err, &perr) {
		t.Fatalf("expected *mesh.ProtocolError; got %T (%v)", err, err)
	}
	return perr
}

func TestDecodeEnvelopeRejectsV1(t *testing.T) {
	raw := []byte(`{"v":1,"type":"join_room","roomId":"demo","requestId":"deadbeef-0000-4000-8000-000000000001","payload":{}}`)
	_, err := mesh.DecodeEnvelope(raw)
	perr := mustProtocolErr(t, err)
	if perr.Code != mesh.CodeUnsupportedVersion {
		t.Fatalf("code = %q, want %q", perr.Code, mesh.CodeUnsupportedVersion)
	}
}

func TestDecodeEnvelopeRejectsV3(t *testing.T) {
	raw := []byte(`{"v":3,"type":"join_room","roomId":"demo","requestId":"deadbeef-0000-4000-8000-000000000001","payload":{}}`)
	_, err := mesh.DecodeEnvelope(raw)
	perr := mustProtocolErr(t, err)
	if perr.Code != mesh.CodeUnsupportedVersion {
		t.Fatalf("code = %q, want %q", perr.Code, mesh.CodeUnsupportedVersion)
	}
}

func TestDecodeEnvelopeRejectsUnknownType(t *testing.T) {
	raw := []byte(`{"v":2,"type":"chat_message","roomId":"demo","payload":{}}`)
	_, err := mesh.DecodeEnvelope(raw)
	perr := mustProtocolErr(t, err)
	if perr.Code != mesh.CodeMalformed {
		t.Fatalf("code = %q, want %q", perr.Code, mesh.CodeMalformed)
	}
}

func TestDecodeEnvelopeRejectsBadJSON(t *testing.T) {
	raw := []byte(`{not-json`)
	_, err := mesh.DecodeEnvelope(raw)
	perr := mustProtocolErr(t, err)
	if perr.Code != mesh.CodeMalformed {
		t.Fatalf("code = %q, want %q", perr.Code, mesh.CodeMalformed)
	}
}

func TestDecodeEnvelopeRejectsJoinRoomMissingRequestID(t *testing.T) {
	raw := []byte(`{"v":2,"type":"join_room","roomId":"demo","payload":{}}`)
	_, err := mesh.DecodeEnvelope(raw)
	perr := mustProtocolErr(t, err)
	if perr.Code != mesh.CodeMalformed {
		t.Fatalf("code = %q, want %q", perr.Code, mesh.CodeMalformed)
	}
}

func TestDecodeEnvelopeRejectsJoinRoomMissingRoomID(t *testing.T) {
	raw := []byte(`{"v":2,"type":"join_room","requestId":"deadbeef-0000-4000-8000-000000000001","payload":{}}`)
	_, err := mesh.DecodeEnvelope(raw)
	perr := mustProtocolErr(t, err)
	if perr.Code != mesh.CodeMalformed {
		t.Fatalf("code = %q, want %q", perr.Code, mesh.CodeMalformed)
	}
}

func TestDecodeEnvelopeAcceptsValidJoinRoom(t *testing.T) {
	raw := []byte(`{"v":2,"type":"join_room","roomId":"demo","requestId":"deadbeef-0000-4000-8000-000000000001","payload":{}}`)
	d, err := mesh.DecodeEnvelope(raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if d.Envelope.Type != mesh.TypeJoinRoom {
		t.Fatalf("type = %q, want %q", d.Envelope.Type, mesh.TypeJoinRoom)
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
	want := map[mesh.ErrorCode]struct{}{
		mesh.CodeAlreadyJoined:              {},
		mesh.CodeUnsupportedVersion:         {},
		mesh.CodeMalformed:                  {},
		mesh.CodeNotInRoom:                  {},
		mesh.CodeUnexpectedMediaReady:       {},
		mesh.CodeUnsupportedMediaCapability: {},
		mesh.CodeUnexpectedOffer:            {},
		mesh.CodeUnexpectedAnswer:           {},
		mesh.CodeStalePairEpoch:             {},
		mesh.CodeStaleRosterUpdate:          {},
		mesh.CodeInternalError:              {},
	}
	if len(mesh.AllErrorCodes) != len(want) {
		t.Fatalf("AllErrorCodes len = %d, want %d", len(mesh.AllErrorCodes), len(want))
	}
	for _, c := range mesh.AllErrorCodes {
		if _, ok := want[c]; !ok {
			t.Errorf("AllErrorCodes contains unexpected code %q", c)
		}
	}
}

// TestRoomFullIsNotAMessageType locks in that the legacy bare
// `room_full` envelope type was not re-introduced.
func TestRoomFullIsNotAMessageType(t *testing.T) {
	for _, t2 := range mesh.AllTypes {
		if string(t2) == "room_full" {
			t.Fatalf("'room_full' must not be a registered MessageType")
		}
	}
}
