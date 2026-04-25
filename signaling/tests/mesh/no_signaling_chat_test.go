// T022 — Audit: FR-053 "no signaling-relayed chat" enforced at the
// contract level. The mesh v2 message-type set MUST NOT include any
// chat-bearing type. Group chat lives on RTCDataChannel only (M8).
//
// Forbidden tokens (compile-time non-existence): `chat_message`,
// `mesh_chat`, `chat`, `text_message`. The test introspects
// mesh.AllTypes and fails if any registered name contains a chat token.

package mesh_test

import (
	"strings"
	"testing"

	"webrtc-lab/signaling/internal/mesh"
)

func TestNoSignalingChatType(t *testing.T) {
	forbidden := []string{"chat_message", "mesh_chat", "text_message"}
	for _, ty := range mesh.AllTypes {
		s := strings.ToLower(string(ty))
		for _, bad := range forbidden {
			if s == bad {
				t.Errorf("forbidden chat-bearing type %q registered in mesh.AllTypes", ty)
			}
		}
		// Guard against any future type whose name contains "chat".
		if strings.Contains(s, "chat") {
			t.Errorf("type %q contains 'chat'; group chat MUST live on RTCDataChannel only (FR-053)", ty)
		}
	}
}

// TestNoScreenShareBusy — bonus audit for FR-041 + Non-Goals at the
// contract level. Mesh has no room-level current-sharer concept so
// screen_share_busy is neither a type nor an error code.
func TestNoScreenShareBusy(t *testing.T) {
	for _, ty := range mesh.AllTypes {
		if strings.Contains(string(ty), "screen_share_busy") {
			t.Errorf("forbidden type %q registered", ty)
		}
	}
	for _, c := range mesh.AllErrorCodes {
		if strings.Contains(string(c), "screen_share_busy") {
			t.Errorf("forbidden error code %q registered", c)
		}
	}
}

// TestRoomFullIsNotAType / IsNotAnErrorCode — pre-admission rejection
// goes through join_rejected only.
func TestRoomFullIsNotATypeNorCode(t *testing.T) {
	for _, ty := range mesh.AllTypes {
		if string(ty) == "room_full" {
			t.Errorf("'room_full' must not be a registered MessageType")
		}
	}
	for _, c := range mesh.AllErrorCodes {
		if string(c) == "room_full" || string(c) == "invalid_room_id" {
			t.Errorf("%q must not be an ErrorCode", c)
		}
	}
}
