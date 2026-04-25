// Package main is the entry point for the webrtc-lab signaling
// server. Phase 2 scope: /healthz, /ws, heartbeat, structured
// lifecycle logs. Room + admission logic (Phase 3) live behind the
// handler and do not run yet.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"webrtc-lab/signaling/internal/logging"
	"webrtc-lab/signaling/internal/mesh"
	sig "webrtc-lab/signaling/internal/signaling"
)

const (
	defaultPort          = "8080"
	readHeaderTimeout    = 10 * time.Second
	shutdownDrainTimeout = 5 * time.Second
	httpReadTimeout      = 30 * time.Second
	httpIdleTimeout      = 120 * time.Second
)

func main() {
	logger := logging.Setup(os.Stdout)
	slog.SetDefault(logger)

	port := os.Getenv("SIGNALING_PORT")
	if _, err := strconv.Atoi(port); err != nil || port == "" {
		port = defaultPort
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", healthzHandler)
	mux.Handle("/ws", sig.NewHandler(logger))
	// 002 mesh endpoint — additive; plan §6.4 preserves /ws v1 unchanged.
	mux.Handle("/ws/mesh", mesh.NewHandler(logger))

	server := &http.Server{
		Addr:              ":" + port,
		Handler:           mux,
		ReadHeaderTimeout: readHeaderTimeout,
		ReadTimeout:       httpReadTimeout,
		IdleTimeout:       httpIdleTimeout,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go func() {
		logger.Info("signaling server starting",
			slog.String("event", "server_start"),
			slog.String("addr", server.Addr),
		)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("server failure",
				slog.String("event", "server_error"),
				slog.String("error", err.Error()),
			)
			stop()
		}
	}()

	<-ctx.Done()

	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownDrainTimeout)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		logger.Warn("graceful shutdown timeout",
			slog.String("event", "server_shutdown_timeout"),
			slog.String("error", err.Error()),
		)
	} else {
		logger.Info("signaling server stopped",
			slog.String("event", "server_stop"),
		)
	}
}

func healthzHandler(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}
