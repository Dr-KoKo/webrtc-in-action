package wsserver

import (
	"context"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

// Session is the per-connection handle modes use to interact with
// the WebSocket transport. Implementations are returned by the
// skeleton; modes never construct one.
type Session interface {
	// ID is the skeleton-assigned conn id (e.g. "c-1", "m-7"). The
	// prefix is set by Config.ConnIDPrefix.
	ID() string

	// BaseContext returns the per-session context. It is cancelled
	// during teardown. Same value as today's
	// onetoone roomConn.baseCtx / mesh connCtx.baseCtx — used by
	// async manager-side broadcasts that happen outside the read
	// loop's own ctx. Writes after teardown fail with ctx.Err();
	// modes performing post-teardown cleanup writes use
	// context.Background() directly.
	BaseContext() context.Context

	// Send writes one text frame. Mutex-serialized internally with
	// a 2 s per-write timeout (matching today's modes' sendJSON).
	// Modes JSON-marshal before calling Send.
	Send(ctx context.Context, payload []byte) error

	// Close sends a graceful close frame. Second-close-error-tolerant
	// — safe to call from inside HandleFrame (e.g. mesh's
	// handleLeaveRoom) and again from teardown. The first call
	// performs the underlying close; subsequent calls are no-ops.
	// The call also tolerates the underlying conn already being
	// closed by heartbeat's CloseNow() — coder/websocket's error in
	// that case is swallowed.
	Close(code websocket.StatusCode, reason string) error
}

// sessionImpl is the private implementation. It wraps a
// *websocket.Conn with the conn id, base context, write mutex,
// and a one-shot close latch.
type sessionImpl struct {
	conn    *websocket.Conn
	id      string
	baseCtx context.Context

	writeMu sync.Mutex
	closed  atomic.Bool
}

func (s *sessionImpl) ID() string                     { return s.id }
func (s *sessionImpl) BaseContext() context.Context   { return s.baseCtx }

func (s *sessionImpl) Send(ctx context.Context, payload []byte) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	writeCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	return s.conn.Write(writeCtx, websocket.MessageText, payload)
}

func (s *sessionImpl) Close(code websocket.StatusCode, reason string) error {
	if !s.closed.CompareAndSwap(false, true) {
		return nil
	}
	// Swallow errors — the underlying conn may already be closed by
	// heartbeat's CloseNow(). This matches today's modes which call
	// `_ = conn.Close(...)` everywhere.
	_ = s.conn.Close(code, reason)
	return nil
}
