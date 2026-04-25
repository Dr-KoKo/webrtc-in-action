// T020 — server-side stale-message rejection. Builds a fake PairLedger
// and asserts ValidateStalePairEpoch returns
// ProtocolError{Code: stale_pair_epoch} on a lower-than-current epoch.
// Forwarding side-effect is asserted via a fake relay sink that the
// caller checks remained empty.

package mesh_test

import (
	"testing"

	"webrtc-lab/signaling/internal/mesh"
)

// fakeLedger satisfies mesh.PairLedger by serving epochs from a map.
type fakeLedger struct{ m map[string]uint64 }

func (f *fakeLedger) CurrentPairEpoch(pairID string) (uint64, bool) {
	v, ok := f.m[pairID]
	return v, ok
}

// fakeSink stands in for the server's relay output. M2 has no real
// relay yet; this type exists so the test asserts "no message
// delivered" symbolically.
type fakeSink struct{ delivered []mesh.Envelope }

func (s *fakeSink) Send(env mesh.Envelope) { s.delivered = append(s.delivered, env) }

// TestStalePairEpochReturnsErrorAndDoesNotForward — inbound pair
// message with payload.pairEpoch < server.currentEpoch[pairId] returns
// ProtocolError{Code: stale_pair_epoch} and (because the caller does
// not forward on error) the relay sink remains empty.
func TestStalePairEpochReturnsErrorAndDoesNotForward(t *testing.T) {
	ledger := &fakeLedger{m: map[string]uint64{"1-3": 2}}
	sink := &fakeSink{}

	// Simulated inbound: pair_offer with payload.pairEpoch = 1, while
	// the ledger's current is 2.
	pair := mesh.PairOfferPayload{}
	pair.PairID = "1-3"
	pair.PairEpoch = 1
	pair.SDP = mesh.SDPBody{Type: "offer", SDP: "v=0\r\n..."}

	if perr := mesh.ValidateStalePairEpoch(pair.PairID, pair.PairEpoch, ledger); perr == nil {
		t.Fatal("expected ProtocolError for stale pairEpoch")
	} else {
		if perr.Code != mesh.CodeStalePairEpoch {
			t.Fatalf("code = %q, want %q", perr.Code, mesh.CodeStalePairEpoch)
		}
	}

	// The sink was never written to because the caller bails on error.
	if len(sink.delivered) != 0 {
		t.Fatalf("expected no forwarded envelopes; got %d", len(sink.delivered))
	}
}

func TestEqualPairEpochAccepted(t *testing.T) {
	ledger := &fakeLedger{m: map[string]uint64{"1-3": 2}}
	if perr := mesh.ValidateStalePairEpoch("1-3", 2, ledger); perr != nil {
		t.Fatalf("expected equal-epoch accepted; got %v", perr)
	}
}

// TestHigherPairEpochRejected — clients are not authoritative, so a
// payload epoch greater than the server's current value is also stale
// (it implies a client invented an epoch the server never issued).
func TestHigherPairEpochRejected(t *testing.T) {
	ledger := &fakeLedger{m: map[string]uint64{"1-3": 2}}
	perr := mesh.ValidateStalePairEpoch("1-3", 3, ledger)
	if perr == nil || perr.Code != mesh.CodeStalePairEpoch {
		t.Fatalf("expected stale_pair_epoch; got %v", perr)
	}
}

func TestUnknownPairIDRejected(t *testing.T) {
	ledger := &fakeLedger{m: map[string]uint64{}}
	perr := mesh.ValidateStalePairEpoch("9-99", 1, ledger)
	if perr == nil || perr.Code != mesh.CodeStalePairEpoch {
		t.Fatalf("expected stale_pair_epoch for unknown pair; got %v", perr)
	}
}
