package wsserver

import (
	"context"
	"errors"

	"github.com/coder/websocket"
)

// classifyReadError maps a read-loop terminal error to the stable
// `reason` string emitted on the disconnect log line. Lifted
// verbatim from
//   signaling/internal/modes/onetoone/handler.go:625-634
//   signaling/internal/modes/mesh/handler.go:643-652
// (both files were char-identical at extraction time).
//
// Importantly: a heartbeat-induced conn.CloseNow() makes the read
// fail with a non-CloseError, so this returns "read_error" rather
// than "pong_timeout" — the readErr-beats-hbErr precedence in
// ServeHTTP's reason switch is preserved by construction.
// Phase-0 characterization tests
// (tests/modes/{onetoone,mesh}/lifecycle_test.go) lock this in.
func classifyReadError(err error) string {
	status := websocket.CloseStatus(err)
	if status != -1 {
		return "peer_close"
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return "ctx_done"
	}
	return "read_error"
}
