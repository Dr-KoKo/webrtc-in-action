// Package logging wires log/slog for the signaling server.
//
// Defaults:
//   - handler: JSON (production-friendly; matches NFR-003's
//     "structured logs" mandate).
//   - level: INFO.
//
// Overrides (env vars, read by Setup):
//   - LOG_FORMAT=text switches to the text handler (local dev).
//   - LOG_LEVEL=debug|info|warn|error sets the minimum level.
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
	"strings"
)

// Setup returns a configured *slog.Logger. If out is nil, os.Stdout is
// used. The returned logger is NOT installed as the default — callers
// that want the package-global default should call slog.SetDefault().
func Setup(out io.Writer) *slog.Logger {
	if out == nil {
		out = os.Stdout
	}

	level := parseLevel(os.Getenv("LOG_LEVEL"))
	opts := &slog.HandlerOptions{Level: level}

	format := strings.ToLower(strings.TrimSpace(os.Getenv("LOG_FORMAT")))
	var handler slog.Handler
	switch format {
	case "text":
		handler = slog.NewTextHandler(out, opts)
	default:
		// JSON is the default for any unset / unrecognized value,
		// including "json".
		handler = slog.NewJSONHandler(out, opts)
	}

	return slog.New(handler)
}

func parseLevel(raw string) slog.Level {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	case "info", "":
		fallthrough
	default:
		return slog.LevelInfo
	}
}
