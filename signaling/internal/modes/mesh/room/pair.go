// Pair / PairEpoch ledger (data-model §A.4 + §A.5). Bound to one
// Room; not safe for concurrent use without the room lock.

package room

import "time"

// PairState — server-side pair lifecycle. M3 only cares about
// PairIdle (registered when the pair first becomes eligible) and
// the epoch counter. M5+ extends this with the negotiation states.
type PairState int

const (
	PairIdle PairState = iota
	PairPairing
	PairConnected
	PairFailed
	PairReconnecting
	PairClosed
)

// Pair — one peer-pair within a Room.
type Pair struct {
	ID        string
	LoPeerID  string
	HiPeerID  string
	State     PairState
	CreatedAt time.Time
}

// PairLedger is the per-room pair-epoch table. *PairLedger
// structurally satisfies the protocol.PairLedger interface (which
// declares only CurrentPairEpoch) — Go's structural typing means we
// do not need to import protocol/ here. The ledger is always
// accessed under the owning Room's mutex; no separate locking.
type PairLedger struct {
	pairs  map[string]*Pair
	epochs map[string]uint64
}

func newPairLedger() *PairLedger {
	return &PairLedger{
		pairs:  make(map[string]*Pair),
		epochs: make(map[string]uint64),
	}
}

// CurrentPairEpoch returns the canonical epoch for pairID. Returns
// false if the pair is unknown to the server (a client sent a pairId
// the server never created). Satisfies the protocol.PairLedger
// interface structurally.
func (l *PairLedger) CurrentPairEpoch(pairID string) (uint64, bool) {
	v, ok := l.epochs[pairID]
	return v, ok
}

// Has reports whether the ledger already tracks pairID. Used by the
// signaling layer's eligibility evaluator to skip pre-existing pairs
// (FR-022a / L18).
func (l *PairLedger) Has(pairID string) bool {
	_, ok := l.pairs[pairID]
	return ok
}

// Pair returns the tracked Pair for pairID or nil. Caller must hold
// the room lock.
func (l *PairLedger) Pair(pairID string) *Pair {
	return l.pairs[pairID]
}

// Lookup returns the tracked Pair for pairID and a presence flag.
// Equivalent to a map lookup over the ledger's pair table; offered
// here so callers do not need access to the unexported map.
func (l *PairLedger) Lookup(pairID string) (*Pair, bool) {
	p, ok := l.pairs[pairID]
	return p, ok
}

// Register starts a new pair at epoch 1 if pairID does not yet
// exist. Returns the (possibly pre-existing) Pair and the canonical
// epoch. The caller computes pairID via the wire-level
// protocol.MakePairID helper before calling.
func (l *PairLedger) Register(pairID, loPeerID, hiPeerID string) (*Pair, uint64) {
	if existing, ok := l.pairs[pairID]; ok {
		return existing, l.epochs[pairID]
	}
	p := &Pair{
		ID:        pairID,
		LoPeerID:  loPeerID,
		HiPeerID:  hiPeerID,
		State:     PairIdle,
		CreatedAt: time.Now(),
	}
	l.pairs[pairID] = p
	l.epochs[pairID] = 1
	return p, 1
}

// Increment bumps the epoch for an existing pair by +1 and returns
// the new value. Caller must already have validated the pair exists
// and that the requester observed the previous epoch.
func (l *PairLedger) Increment(pairID string) (uint64, bool) {
	cur, ok := l.epochs[pairID]
	if !ok {
		return 0, false
	}
	cur++
	l.epochs[pairID] = cur
	return cur, true
}

// Drop removes the pair entirely. Used when both endpoints are gone
// (data-model §C.4 step 3).
func (l *PairLedger) Drop(pairID string) {
	delete(l.pairs, pairID)
	delete(l.epochs, pairID)
}
