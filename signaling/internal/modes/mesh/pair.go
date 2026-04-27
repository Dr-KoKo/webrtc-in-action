// Pair / PairEpoch ledger (data-model §A.4 + §A.5). Bound to one
// MeshRoom; not safe for concurrent use without the room lock.

package mesh

import "time"

// PairState — server-side pair lifecycle. M3 only cares about
// PairIdle (registered when the pair first becomes eligible) and the
// epoch counter. M5+ extends this with the negotiation states.
type PairState int

const (
	PairIdle PairState = iota
	PairPairing
	PairConnected
	PairFailed
	PairReconnecting
	PairClosed
)

// Pair — one peer-pair within a MeshRoom.
type Pair struct {
	ID        string
	LoPeerID  string
	HiPeerID  string
	State     PairState
	CreatedAt time.Time
}

// pairLedger is the per-room implementation of mesh.PairLedger
// (declared in protocol.go). It owns the `pairEpoch` map and is
// always accessed under the owning MeshRoom's mutex — no separate
// locking here.
type pairLedger struct {
	pairs  map[string]*Pair
	epochs map[string]uint64
}

func newPairLedger() *pairLedger {
	return &pairLedger{
		pairs:  make(map[string]*Pair),
		epochs: make(map[string]uint64),
	}
}

// CurrentPairEpoch satisfies mesh.PairLedger. Returns false if the
// pair is unknown to the server (a client sent a pairId the server
// never created).
func (l *pairLedger) CurrentPairEpoch(pairID string) (uint64, bool) {
	v, ok := l.epochs[pairID]
	return v, ok
}

// Register starts a new pair at epoch 1 if it does not yet exist.
// Returns the (possibly pre-existing) Pair and the canonical epoch.
func (l *pairLedger) Register(loPeerID, hiPeerID string, loIdx, hiIdx uint64) (*Pair, uint64) {
	id := MakePairID(loIdx, hiIdx)
	if existing, ok := l.pairs[id]; ok {
		return existing, l.epochs[id]
	}
	p := &Pair{
		ID:        id,
		LoPeerID:  loPeerID,
		HiPeerID:  hiPeerID,
		State:     PairIdle,
		CreatedAt: time.Now(),
	}
	l.pairs[id] = p
	l.epochs[id] = 1
	return p, 1
}

// Increment bumps the epoch for an existing pair by +1 and returns
// the new value. Caller must already have validated the pair exists
// and that the requester observed the previous epoch.
func (l *pairLedger) Increment(pairID string) (uint64, bool) {
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
func (l *pairLedger) Drop(pairID string) {
	delete(l.pairs, pairID)
	delete(l.epochs, pairID)
}
