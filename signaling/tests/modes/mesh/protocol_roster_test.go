// Roster-family round-trip + 7-state presence enum invariant.

package mesh_test

import (
	"encoding/json"
	"testing"

	protocol "webrtc-lab/signaling/internal/modes/mesh/protocol"
)

func TestMeshRosterSnapshotRoundTrip(t *testing.T) {
	payload, _ := json.Marshal(protocol.MeshRosterSnapshotPayload{
		ServerSeq: 12,
		Participants: []protocol.RosterParticipant{
			{PeerID: "11111111-2222-4333-8444-555555555555", AdmissionIndex: 1, Presence: protocol.PresenceConnected},
			{PeerID: "22222222-3333-4444-8555-666666666666", AdmissionIndex: 2, Presence: protocol.PresenceMediaReady},
		},
	})
	if err := protocol.Validate(protocol.TypeMeshRosterSnapshot, payload); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestMeshRosterUpdateRoundTrip(t *testing.T) {
	payload, _ := json.Marshal(protocol.MeshRosterUpdatePayload{
		ServerSeq:      17,
		SubjectPeerID:  "11111111-2222-4333-8444-555555555555",
		AdmissionIndex: 3,
		Presence:       protocol.PresenceMediaReady,
		Reason:         protocol.RosterReasonMediaReady,
	})
	if err := protocol.Validate(protocol.TypeMeshRosterUpdate, payload); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

// TestPresenceEnumIsExactlySevenStates locks in the FR-013 vocabulary.
// Adding or removing a value here requires a contract revision.
func TestPresenceEnumIsExactlySevenStates(t *testing.T) {
	want := map[protocol.Presence]struct{}{
		protocol.PresenceJoined:     {},
		protocol.PresenceMediaReady: {},
		protocol.PresenceConnecting: {},
		protocol.PresenceConnected:  {},
		protocol.PresenceFailed:     {},
		protocol.PresenceReleased:   {},
		protocol.PresenceLeft:       {},
	}
	if len(protocol.AllPresences) != len(want) {
		t.Fatalf("AllPresences len = %d, want %d", len(protocol.AllPresences), len(want))
	}
	for _, p := range protocol.AllPresences {
		if _, ok := want[p]; !ok {
			t.Errorf("AllPresences contains unexpected presence %q", p)
		}
	}
}

func TestMeshRosterUpdateRejectsUnknownPresence(t *testing.T) {
	payload := []byte(`{"serverSeq":1,"subjectPeerId":"11111111-2222-4333-8444-555555555555","admissionIndex":1,"presence":"in-call","reason":"admitted"}`)
	if err := protocol.Validate(protocol.TypeMeshRosterUpdate, payload); err == nil {
		t.Fatal("expected unknown presence to be rejected")
	}
}
