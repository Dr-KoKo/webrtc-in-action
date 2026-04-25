// Pair-family round-trip + invariant tests (contract §3.9–§3.16).

package mesh_test

import (
	"encoding/json"
	"strings"
	"testing"

	"webrtc-lab/signaling/internal/mesh"
)

func TestPairNegotiationInstructionRoundTrip(t *testing.T) {
	payload, _ := json.Marshal(map[string]any{
		"pairId":    "1-3",
		"pairEpoch": 1,
		"role":      "offerer",
		"remotePeer": map[string]any{
			"peerId":         "11111111-2222-4333-8444-555555555555",
			"admissionIndex": 3,
		},
		"iceServers": []any{
			map[string]any{"urls": []string{"stun:stun.l.google.com:19302"}},
		},
	})
	if err := mesh.Validate(mesh.TypePairNegotiationInstruction, payload); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestPairOfferRequiresPairEpoch(t *testing.T) {
	payload := []byte(`{"pairId":"1-3","sdp":{"type":"offer","sdp":"v=0\r\n..."}}`)
	err := mesh.Validate(mesh.TypePairOffer, payload)
	if err == nil || !strings.Contains(err.Error(), "pairEpoch") {
		t.Fatalf("expected pairEpoch malformed; got %v", err)
	}
}

func TestPairOfferRequiresPairID(t *testing.T) {
	payload := []byte(`{"pairEpoch":1,"sdp":{"type":"offer","sdp":"v=0\r\n..."}}`)
	err := mesh.Validate(mesh.TypePairOffer, payload)
	if err == nil || !strings.Contains(err.Error(), "pairId") {
		t.Fatalf("expected pairId malformed; got %v", err)
	}
}

func TestPairAnswerSDPTypeMustBeAnswer(t *testing.T) {
	payload := []byte(`{"pairId":"1-3","pairEpoch":1,"sdp":{"type":"offer","sdp":"v=0\r\n..."}}`)
	err := mesh.Validate(mesh.TypePairAnswer, payload)
	if err == nil || !strings.Contains(err.Error(), "answer") {
		t.Fatalf("expected sdp.type 'answer' enforcement; got %v", err)
	}
}

func TestPairIceCandidateAcceptsNullEndOfCandidates(t *testing.T) {
	payload := []byte(`{"pairId":"1-3","pairEpoch":1,"candidate":null}`)
	if err := mesh.Validate(mesh.TypePairIceCandidate, payload); err != nil {
		t.Fatalf("expected candidate:null accepted; got %v", err)
	}
}

func TestPairIceCandidateRejectsEmptyString(t *testing.T) {
	payload := []byte(`{"pairId":"1-3","pairEpoch":1,"candidate":{"candidate":""}}`)
	err := mesh.Validate(mesh.TypePairIceCandidate, payload)
	var perr *mesh.ProtocolError
	if !asProtocolError(err, &perr) || perr.Code != mesh.CodeMalformed {
		t.Fatalf("expected malformed for candidate:''; got %v", err)
	}
}

func TestPairIceCandidateRejectsMissingKey(t *testing.T) {
	payload := []byte(`{"pairId":"1-3","pairEpoch":1}`)
	err := mesh.Validate(mesh.TypePairIceCandidate, payload)
	var perr *mesh.ProtocolError
	if !asProtocolError(err, &perr) || perr.Code != mesh.CodeMalformed {
		t.Fatalf("expected malformed for missing candidate key; got %v", err)
	}
}

// TestPairMediaStateHasNoPairIdNorPairEpoch — contract §3.13 says
// pair_media_state is participant-level: it does NOT carry pairId or
// pairEpoch. The validator MUST accept payloads without those fields.
func TestPairMediaStateAcceptsParticipantLevelPayload(t *testing.T) {
	payload := []byte(`{"microphone":"on","camera":"on","screenShare":"active"}`)
	if err := mesh.Validate(mesh.TypePairMediaState, payload); err != nil {
		t.Fatalf("expected participant-level payload accepted; got %v", err)
	}
}

func TestPairMediaStateRequiresFullTriple(t *testing.T) {
	cases := [][]byte{
		[]byte(`{"camera":"on","screenShare":"inactive"}`),
		[]byte(`{"microphone":"on","screenShare":"inactive"}`),
		[]byte(`{"microphone":"on","camera":"on"}`),
	}
	for _, c := range cases {
		if err := mesh.Validate(mesh.TypePairMediaState, c); err == nil {
			t.Errorf("expected partial triple %s rejected", c)
		}
	}
}

func TestReconnectPairRoundTrip(t *testing.T) {
	payload, _ := json.Marshal(mesh.ReconnectPairPayload{PairID: "1-3", ObservedEpoch: 1})
	if err := mesh.Validate(mesh.TypeReconnectPair, payload); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestPairFailedRoundTrip(t *testing.T) {
	payload, _ := json.Marshal(map[string]any{
		"pairId":    "1-3",
		"pairEpoch": 1,
		"reason":    "ice_failure",
		"detail":    "iceConnectionState=failed",
	})
	if err := mesh.Validate(mesh.TypePairFailed, payload); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

// TestMakePairIDIsSorted asserts MakePairID is order-independent.
func TestMakePairIDIsSorted(t *testing.T) {
	if got := mesh.MakePairID(7, 3); got != "3-7" {
		t.Errorf("MakePairID(7,3) = %q, want \"3-7\"", got)
	}
	if got := mesh.MakePairID(3, 7); got != "3-7" {
		t.Errorf("MakePairID(3,7) = %q, want \"3-7\"", got)
	}
}
