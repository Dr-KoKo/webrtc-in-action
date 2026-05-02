// Participant FSM (data-model §A.3). Mesh participant lifecycle is
// strictly four states server-side:
//   joined → media-ready → left
//          ↘ released (terminal pre-pairing)
//
// `released` is only reachable from `joined` (the sender's
// media_failed before any pair existed). Departures from
// `media-ready` (or any later pair state) classify as `left` and
// trigger pair teardown for every pair the participant was in
// (data-model §C.4).

package room

import (
	"errors"
	"time"
)

// Readiness — the four-element FSM. Mirrors data-model §A.3 enum.
type Readiness string

const (
	ReadinessJoined     Readiness = "joined"
	ReadinessMediaReady Readiness = "media-ready"
	ReadinessReleased   Readiness = "released"
	ReadinessLeft       Readiness = "left"
)

// Participant — one admitted mesh browser session.
type Participant struct {
	PeerID         string
	AdmissionIndex uint64
	Readiness      Readiness
	Conn           Conn
	JoinedAt       time.Time
	LastSeen       time.Time
}

// ErrInvalidReadinessTransition is returned by Advance when a
// transition is not in the FSM diagram. The signaling layer maps this
// to the wire-level `error { code: "unexpected_media_ready" }` for
// media_ready arriving from a non-`joined` state.
var ErrInvalidReadinessTransition = errors.New("invalid mesh participant readiness transition")

// Advance returns the new readiness for the requested transition or
// ErrInvalidReadinessTransition if the move is not permitted by the
// FSM. Idempotent on same-state requests (returns the same value with
// no error) since callers may invoke this from re-entrant paths.
func Advance(from, to Readiness) (Readiness, error) {
	if from == to {
		return from, nil
	}
	switch from {
	case ReadinessJoined:
		switch to {
		case ReadinessMediaReady, ReadinessReleased, ReadinessLeft:
			return to, nil
		}
	case ReadinessMediaReady:
		// `media-ready → released` is forbidden once pairs may have
		// formed (data-model §A.3); only `left` is reachable.
		if to == ReadinessLeft {
			return to, nil
		}
	}
	return from, ErrInvalidReadinessTransition
}
