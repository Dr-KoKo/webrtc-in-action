// Per-mode heartbeat labels. The keep-alive loop itself lives in
// `internal/shared/heartbeat`. This file only carries the
// observable-log strings the 001 protocol uses on pong-timeout, kept
// verbatim from the pre-refactor implementation:
//
//   slog.Info("heartbeat pong timeout", slog.String("event", "pong_timeout"), ...)

package onetoone

import "webrtc-lab/signaling/internal/shared/heartbeat"

// oneToOneHeartbeatLabels is the per-mode label set passed to
// `heartbeat.Run`. Adding fields here requires extending
// `heartbeat.Labels` in the shared package.
var oneToOneHeartbeatLabels = heartbeat.Labels{
	PongTimeoutEvent:   "pong_timeout",
	PongTimeoutMessage: "heartbeat pong timeout",
}

// Type aliases preserve the pre-refactor `sig.HeartbeatConfig` /
// `sig.HeartbeatError` test-import surface. The actual implementations
// now live in `internal/shared/heartbeat`; aliasing keeps the existing
// test bodies working without duplicating the type.
type HeartbeatConfig = heartbeat.Config
type HeartbeatError = heartbeat.HeartbeatError
