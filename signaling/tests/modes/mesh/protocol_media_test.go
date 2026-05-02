// Media-readiness round-trip + audio/video required-true invariant.

package mesh_test

import (
	"encoding/json"
	"testing"

	protocol "webrtc-lab/signaling/internal/modes/mesh/protocol"
)

func TestMediaReadyAcceptsAudioVideoTrue(t *testing.T) {
	payload, _ := json.Marshal(protocol.MediaReadyPayload{
		MediaCapabilities: protocol.MediaCapabilities{Audio: true, Video: true},
	})
	if err := protocol.Validate(protocol.TypeMediaReady, payload); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestMediaReadyRejectsAudioFalse(t *testing.T) {
	payload := []byte(`{"mediaCapabilities":{"audio":false,"video":true}}`)
	err := protocol.Validate(protocol.TypeMediaReady, payload)
	var perr *protocol.ProtocolError
	if !asProtocolError(err, &perr) || perr.Code != protocol.CodeUnsupportedMediaCapability {
		t.Fatalf("got %v, want unsupported_media_capability", err)
	}
}

func TestMediaReadyRejectsVideoFalse(t *testing.T) {
	payload := []byte(`{"mediaCapabilities":{"audio":true,"video":false}}`)
	err := protocol.Validate(protocol.TypeMediaReady, payload)
	var perr *protocol.ProtocolError
	if !asProtocolError(err, &perr) || perr.Code != protocol.CodeUnsupportedMediaCapability {
		t.Fatalf("got %v, want unsupported_media_capability", err)
	}
}

func TestMediaFailedRoundTrip(t *testing.T) {
	for _, r := range []protocol.MediaFailedReason{
		protocol.MediaFailedPermissionDenied,
		protocol.MediaFailedDeviceNotFound,
		protocol.MediaFailedDeviceInUse,
		protocol.MediaFailedOther,
	} {
		payload, _ := json.Marshal(protocol.MediaFailedPayload{Reason: r, Detail: "x"})
		if err := protocol.Validate(protocol.TypeMediaFailed, payload); err != nil {
			t.Errorf("reason %q rejected: %v", r, err)
		}
	}
}

func TestMediaFailedRejectsUnknownReason(t *testing.T) {
	payload := []byte(`{"reason":"weird"}`)
	if err := protocol.Validate(protocol.TypeMediaFailed, payload); err == nil {
		t.Fatal("expected unknown reason to be rejected")
	}
}
