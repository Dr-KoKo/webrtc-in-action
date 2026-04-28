// Package app composes the per-mode HTTP handlers behind a single
// http.ServeMux. The boundary between this package and the mode
// packages is one-way: app imports each mode to instantiate its
// handler, but no mode imports app.
//
// `RegisterRoutes` wires:
//   - /healthz       (lifted verbatim from cmd/signaling/main.go;
//                     uses json.NewEncoder.Encode → trailing newline
//                     preserved byte-for-byte)
//   - /ws            (one-to-one mode, contract v1)
//   - /ws/mesh       (mesh mode, contract v2)
//
// Adding a new mode (SFU, recording, …) means: add an entry to
// `MODES` in the frontend registry AND add one `mux.Handle("/ws/<id>",
// <id>.NewHandler(deps.Logger))` line below.
package app

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"webrtc-lab/signaling/internal/modes/mesh"
	onetoone "webrtc-lab/signaling/internal/modes/onetoone"
)

// Deps carries the shared dependencies handlers need at construction.
// Today: just the logger. Future shared resources (metrics, config
// snapshot) attach here.
type Deps struct {
	Logger *slog.Logger
}

// RegisterRoutes installs every mode's handler plus the /healthz
// liveness probe. Order: /healthz first, then per-mode endpoints.
// /healthz must be cheap and free of mode logic so the Docker
// healthcheck and `cmd/healthprobe` continue to gate compose
// dependencies correctly.
func RegisterRoutes(mux *http.ServeMux, deps Deps) {
	mux.HandleFunc("/healthz", healthzHandler)
	mux.Handle("/ws", onetoone.NewHandler(deps.Logger))
	mux.Handle("/ws/mesh", mesh.NewHandler(deps.Logger))
}

// healthzHandler is lifted byte-for-byte from the pre-refactor
// `cmd/signaling/main.go` so the response body — `{"status":"ok"}\n`
// (json.NewEncoder.Encode appends the trailing newline) — is
// preserved exactly. Docker healthcheck / `cmd/healthprobe` continue
// to work without re-validation.
func healthzHandler(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}
