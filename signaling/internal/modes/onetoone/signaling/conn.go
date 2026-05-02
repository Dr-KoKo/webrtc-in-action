// Package signaling implements the WebRTC verbs for the 001 1:1
// contract: admission, negotiation, trickle, media-state, presence.
// See specs/signaling-architecture.md §2.3 (Ring 3) and §3.1.
//
// The verbs reach the per-conn write surface only through the
// signaling.Conn interface declared here. The mode root implements
// it; this package never imports the mode root, which keeps the
// dependency direction acyclic.
package signaling

import (
	"webrtc-lab/signaling/internal/modes/onetoone/room"
)

// ConnState is a snapshot of per-session join/release state.
// Returned by value so the caller cannot mutate the session
// indirectly. The mutator methods on Conn are the only sanctioned
// way to change a session's joined/released state.
type ConnState struct {
	PeerID   string
	RoomID   string
	Released bool
}

// Conn is the per-conn surface the signaling verbs use. It embeds
// room.Conn so a signaling.Conn value is also usable wherever a
// room.Conn is expected (e.g. RoomManager.Admit), without a
// downcast.
//
// Allowed mutation sequences (per specs/signaling-architecture.md
// §3.4):
//
//   - Join accepted:               MarkJoined(peerID, roomID)
//   - Graceful leave / disconnect: ReleaseOnce() -> ClearJoined()
//   - media_failed retry:          ReleaseOnce() -> ClearJoined() ->
//     ResetReleaseLatch()
//
// No verb may call ClearJoined without a preceding ReleaseOnce that
// returned true. ResetReleaseLatch is only valid on the
// media_failed retry path.
type Conn interface {
	room.Conn // BaseContext() context.Context + SendJSON(ctx, v) error

	ID() string
	CloseNormal(reason string) error

	State() ConnState
	MarkJoined(peerID, roomID string)
	ClearJoined()
	ReleaseOnce() bool // CAS true → returns true on first call
	ResetReleaseLatch()
}
