// Package wsserver hosts the WebSocket session lifecycle skeleton
// shared by every signaling mode. Modes (onetoone, mesh, future
// SFU, …) own their envelope schemas, error codes, dispatch, and
// FSMs — the lesson. wsserver owns transport: Accept, conn-id
// assignment, heartbeat goroutine launch, write serialization,
// read loop, error classification, teardown ordering. Each mode's
// handler.go opens with topology because this package hides the
// plumbing.
//
// The constitution (Principle IX) forbids "generic Transport
// interfaces with one implementation." Two modes use this today
// and SFU is in the architecture roadmap, so the abstraction is
// grounded in concrete duplication. Heartbeat
// (internal/shared/heartbeat) is the same pattern, lifted only
// once duplication was concrete.
package wsserver

import (
	"context"
	"log/slog"
)

// SessionHandler is the per-connection mode-side state. The
// skeleton calls HandleFrame for each inbound frame and
// OnDisconnect once during teardown.
type SessionHandler interface {
	// HandleFrame is called for each inbound text frame. Modes log
	// non-fatal errors with their own mode-specific fields and
	// return nil. ANY non-nil return is terminal — the skeleton
	// ends the read loop and proceeds to teardown.
	HandleFrame(ctx context.Context, frame []byte) error

	// OnDisconnect runs once during teardown, AFTER the read context
	// is cancelled. No context is passed; modes use
	// context.Background() (or their own bounded ctx) for cleanup
	// writes — this matches today's
	// onetoone:172 releaseAndNotify(context.Background(), ...).
	//
	// transportReason is the wsserver-classified disconnect cause
	// (one of: "peer_close", "ctx_done", "read_error",
	// "pong_timeout", "ping_failed", "heartbeat_error",
	// "newsession_refused", or "closed"). Modes MUST NOT forward
	// this string into their domain cleanup — presence/roster
	// reasons stay mode-owned.
	//
	// Returned []slog.Attr are merged into the skeleton's single
	// disconnect log line (this is how onetoone preserves its
	// optional peer_id field on admitted-disconnect logs without
	// splitting into two log lines).
	OnDisconnect(transportReason string) []slog.Attr
}

// Mode is the per-handler factory. Implementations create one
// SessionHandler per accepted WebSocket. Returning a non-nil error
// from NewSession refuses the session: the skeleton sends a
// graceful close with status websocket.StatusInternalError and
// reason "newsession_refused", emits a disconnect log line with
// reason="newsession_refused" and the error message in a
// "refuse_error" slog attr, and does NOT call OnDisconnect (no
// SessionHandler exists). Neither current mode uses this path —
// both admit/reject inside frame handlers — but a future mode with
// synchronous admission can rely on the contract.
//
// The *slog.Logger passed here is Config.Logger verbatim — NOT
// pre-tagged with conn_id. Modes keep their current per-call-site
// convention of adding slog.String("conn_id", sess.ID()) etc.
type Mode interface {
	NewSession(sess Session, log *slog.Logger) (SessionHandler, error)
}
