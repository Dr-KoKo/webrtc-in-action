// Package main is the entry point for the webrtc-lab signaling
// server. Mode-specific handlers + /healthz live in
// `internal/app/routes.go`; this file only owns lifecycle (logger,
// listener, signal-driven shutdown). Adding a new mode does not
// require editing main.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"webrtc-lab/signaling/internal/app"
	"webrtc-lab/signaling/internal/shared/logging"
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
	app.RegisterRoutes(mux, app.Deps{Logger: logger})

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
