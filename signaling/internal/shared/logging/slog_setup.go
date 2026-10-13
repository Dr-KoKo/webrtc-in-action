// Package logging wires log/slog for the signaling server.
//
// Defaults: JSON handler (production-friendly per NFR-003), INFO level.
// All env reading lives in internal/shared/config; this package no
// longer reads LOG_LEVEL or LOG_FORMAT directly. Callers (cmd/signaling)
// build a Config from config.Load() and hand it to Setup.
//
// Per NFR-003, callers MUST NOT log SDP bodies, ICE candidate strings,
// or TURN credentials. This package does not enforce that — it only
// configures the handler. The invariant lives in the per-log-site
// discipline and is spot-checked by T020.
package logging

import (
	"io"
	"log/slog"
	"os"
)

// Format selects the slog handler. Only "json" and "text" are valid;
// config.Load() validates the env value before constructing this.
type Format string

const (
	FormatJSON Format = "json"
	FormatText Format = "text"
)

// Config is the parsed logging configuration. Built by
// internal/shared/config from LOG_LEVEL / LOG_FORMAT env vars.
type Config struct {
	Level  slog.Level
	Format Format
}

// Setup returns a configured *slog.Logger. If out is nil, os.Stdout is
// used. The returned logger is NOT installed as the default — callers
// that want the package-global default should call slog.SetDefault().
func Setup(out io.Writer, cfg Config) *slog.Logger {
	if out == nil {
		out = os.Stdout
	}

	opts := &slog.HandlerOptions{Level: cfg.Level}

	var handler slog.Handler
	switch cfg.Format {
	case FormatText:
		handler = slog.NewTextHandler(out, opts)
	default:
		// JSON for the zero-value Format and any unrecognized value.
		handler = slog.NewJSONHandler(out, opts)
	}

	return slog.New(handler)
}
