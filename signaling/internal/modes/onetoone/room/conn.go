package room

import "context"

// Conn is the minimum surface the room package needs on the
// underlying WS connection. The mode root supplies the real
// implementation; signaling/ embeds this interface in its own Conn
// so a signaling.Conn is also usable wherever a room.Conn is
// expected.
//
// BaseContext returns the *target* session's base context.
// Async fan-outs (presence, peer_left) iterate participants and
// write to other sessions whose context is unrelated to the
// caller's request ctx; the explicit accessor lets the caller
// thread the right ctx without an implicit-capture adapter.
//
// Implementations MUST be safe for concurrent use across SendJSON
// calls and WS reads.
type Conn interface {
	BaseContext() context.Context
	// SendJSON marshals v as a text frame and writes it to the peer.
	// Implementations are responsible for serializing writes.
	SendJSON(ctx context.Context, v any) error
}
