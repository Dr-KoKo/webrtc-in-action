// Package main is the entry point for the webrtc-lab signaling
// server. Mode-specific handlers + /healthz live in
// `internal/app/routes.go`; this file only owns lifecycle:
// (1) load + validate config (fail-fast before logger setup),
// (2) build logger from cfg.Logging,
// (3) register routes,
// (4) listen + signal-driven shutdown.
// Adding a new mode does not require editing main.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"webrtc-lab/signaling/internal/app"
	"webrtc-lab/signaling/internal/shared/config"
	"webrtc-lab/signaling/internal/shared/logging"
)

const (
	readHeaderTimeout    = 10 * time.Second
	shutdownDrainTimeout = 5 * time.Second
	httpReadTimeout      = 30 * time.Second
	httpIdleTimeout      = 120 * time.Second
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintln(os.Stderr, "signaling: config load failed:", err)
		os.Exit(2)
	}

	logger := logging.Setup(os.Stdout, cfg.Logging)
	slog.SetDefault(logger)

	mux := http.NewServeMux()
	app.RegisterRoutes(mux, app.Deps{Logger: logger, Cfg: cfg})

	server := &http.Server{
		Addr:              ":" + cfg.Server.Port,
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
			slog.String("env", string(cfg.Env)),
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
