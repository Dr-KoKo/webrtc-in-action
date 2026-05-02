// Per-mode heartbeat labels. The keep-alive loop itself lives in
// `internal/shared/heartbeat`. This file only carries the
// observable-log strings the mesh protocol uses on pong-timeout, kept
// verbatim from the pre-refactor implementation:
//
//   slog.Info("mesh heartbeat pong timeout", slog.String("event", "mesh_pong_timeout"), ...)

package mesh

import "webrtc-lab/signaling/internal/shared/heartbeat"

// meshHeartbeatLabels is the per-mode label set passed to
// `heartbeat.Run`. Adding fields here requires extending
// `heartbeat.Labels` in the shared package.
var meshHeartbeatLabels = heartbeat.Labels{
	PongTimeoutEvent:   "mesh_pong_timeout",
	PongTimeoutMessage: "mesh heartbeat pong timeout",
}
