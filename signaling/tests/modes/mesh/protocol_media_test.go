// Media-readiness round-trip + audio/video required-true invariant.

package mesh_test

import (
	"encoding/json"
	"testing"

	"webrtc-lab/signaling/internal/modes/mesh"
)

func TestMediaReadyAcceptsAudioVideoTrue(t *testing.T) {
	payload, _ := json.Marshal(mesh.MediaReadyPayload{
		MediaCapabilities: mesh.MediaCapabilities{Audio: true, Video: true},
	})
	if err := mesh.Validate(mesh.TypeMediaReady, payload); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestMediaReadyRejectsAudioFalse(t *testing.T) {
	payload := []byte(`{"mediaCapabilities":{"audio":false,"video":true}}`)
	err := mesh.Validate(mesh.TypeMediaReady, payload)
	var perr *mesh.ProtocolError
	if !asProtocolError(err, &perr) || perr.Code != mesh.CodeUnsupportedMediaCapability {
		t.Fatalf("got %v, want unsupported_media_capability", err)
	}
}

func TestMediaReadyRejectsVideoFalse(t *testing.T) {
	payload := []byte(`{"mediaCapabilities":{"audio":true,"video":false}}`)
	err := mesh.Validate(mesh.TypeMediaReady, payload)
	var perr *mesh.ProtocolError
	if !asProtocolError(err, &perr) || perr.Code != mesh.CodeUnsupportedMediaCapability {
		t.Fatalf("got %v, want unsupported_media_capability", err)
	}
}

func TestMediaFailedRoundTrip(t *testing.T) {
	for _, r := range []mesh.MediaFailedReason{
		mesh.MediaFailedPermissionDenied,
		mesh.MediaFailedDeviceNotFound,
		mesh.MediaFailedDeviceInUse,
		mesh.MediaFailedOther,
	} {
		payload, _ := json.Marshal(mesh.MediaFailedPayload{Reason: r, Detail: "x"})
		if err := mesh.Validate(mesh.TypeMediaFailed, payload); err != nil {
			t.Errorf("reason %q rejected: %v", r, err)
		}
	}
}

func TestMediaFailedRejectsUnknownReason(t *testing.T) {
	payload := []byte(`{"reason":"weird"}`)
	if err := mesh.Validate(mesh.TypeMediaFailed, payload); err == nil {
		t.Fatal("expected unknown reason to be rejected")
	}
}
