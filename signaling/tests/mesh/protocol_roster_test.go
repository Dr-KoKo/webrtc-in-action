// Roster-family round-trip + 7-state presence enum invariant.

package mesh_test

import (
	"encoding/json"
	"testing"

	"webrtc-lab/signaling/internal/mesh"
)

func TestMeshRosterSnapshotRoundTrip(t *testing.T) {
	payload, _ := json.Marshal(mesh.MeshRosterSnapshotPayload{
		ServerSeq: 12,
		Participants: []mesh.RosterParticipant{
			{PeerID: "11111111-2222-4333-8444-555555555555", AdmissionIndex: 1, Presence: mesh.PresenceConnected},
			{PeerID: "22222222-3333-4444-8555-666666666666", AdmissionIndex: 2, Presence: mesh.PresenceMediaReady},
		},
	})
	if err := mesh.Validate(mesh.TypeMeshRosterSnapshot, payload); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestMeshRosterUpdateRoundTrip(t *testing.T) {
	payload, _ := json.Marshal(mesh.MeshRosterUpdatePayload{
		ServerSeq:      17,
		SubjectPeerID:  "11111111-2222-4333-8444-555555555555",
		AdmissionIndex: 3,
		Presence:       mesh.PresenceMediaReady,
		Reason:         mesh.RosterReasonMediaReady,
	})
	if err := mesh.Validate(mesh.TypeMeshRosterUpdate, payload); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

// TestPresenceEnumIsExactlySevenStates locks in the FR-013 vocabulary.
// Adding or removing a value here requires a contract revision.
func TestPresenceEnumIsExactlySevenStates(t *testing.T) {
	want := map[mesh.Presence]struct{}{
		mesh.PresenceJoined:     {},
		mesh.PresenceMediaReady: {},
		mesh.PresenceConnecting: {},
		mesh.PresenceConnected:  {},
		mesh.PresenceFailed:     {},
		mesh.PresenceReleased:   {},
		mesh.PresenceLeft:       {},
	}
	if len(mesh.AllPresences) != len(want) {
		t.Fatalf("AllPresences len = %d, want %d", len(mesh.AllPresences), len(want))
	}
	for _, p := range mesh.AllPresences {
		if _, ok := want[p]; !ok {
			t.Errorf("AllPresences contains unexpected presence %q", p)
		}
	}
}

func TestMeshRosterUpdateRejectsUnknownPresence(t *testing.T) {
	payload := []byte(`{"serverSeq":1,"subjectPeerId":"11111111-2222-4333-8444-555555555555","admissionIndex":1,"presence":"in-call","reason":"admitted"}`)
	if err := mesh.Validate(mesh.TypeMeshRosterUpdate, payload); err == nil {
		t.Fatal("expected unknown presence to be rejected")
	}
}
