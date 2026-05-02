// Package room owns the mesh server-side state model: rooms,
// participants, pair-epoch ledger, and the FSM transitions over
// them. Per specs/signaling-architecture.md §2.2 (Ring 2) it has no
// schema, no envelope decode, and no HTTP/WebSocket lifecycle.
//
// Cross-mode separation: 001 has its own `room` package under
// modes/onetoone/room. The two registries share NOTHING; a room ID
// may exist in both without collision (data-model §A.1
// "Invariants"). No code in this package imports the 001 room
// package.
package room

import "context"

// Conn is the minimum surface the room package needs on the
// underlying WS connection. The mode root supplies the real
// implementation; mesh/signaling/ embeds this interface in its own
// Conn so a signaling.Conn is also usable wherever a room.Conn is
// expected.
//
// BaseContext returns the *target* session's base context.
// Async fan-outs (roster updates, peer_left, pair instructions)
// iterate participants and write to other sessions whose context
// is unrelated to the caller's request ctx; the explicit accessor
// lets the caller thread the right ctx without an implicit-capture
// adapter.
//
// Implementations MUST be safe for concurrent use across SendJSON
// calls and WS reads.
type Conn interface {
	BaseContext() context.Context
	// SendJSON marshals v as a text frame and writes it to the peer.
	// Implementations are responsible for serializing writes.
	SendJSON(ctx context.Context, v any) error
}
