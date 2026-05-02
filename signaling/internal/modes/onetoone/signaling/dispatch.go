package signaling

import (
	"context"
	"errors"
	"log/slog"

	"webrtc-lab/signaling/internal/modes/onetoone/protocol"
)

// HandleFrame is the single entry point invoked by the per-conn
// SessionHandler in the mode root. It decodes the inbound envelope,
// writes a typed `error` frame back on decode failure, and
// otherwise hands the decoded value to Dispatch. Returns nil to
// keep the read loop alive on non-fatal protocol errors — a
// malformed frame is logged + answered with an `error` envelope but
// does not tear the WebSocket down.
func (s *Service) HandleFrame(ctx context.Context, conn Conn, frame []byte) error {
	decoded, derr := protocol.Decode(frame)
	if derr != nil {
		var de *protocol.DecodeError
		errors.As(derr, &de)
		s.writeError(ctx, conn, de, "")
		s.Log.Debug("decode error",
			slog.String("conn_id", conn.ID()),
			slog.String("code", string(de.Code)),
		)
		return nil
	}
	if err := s.Dispatch(ctx, conn, decoded); err != nil {
		s.Log.Debug("dispatch error",
			slog.String("conn_id", conn.ID()),
			slog.String("type", string(decoded.Envelope.Type)),
			slog.String("error", err.Error()),
		)
	}
	return nil
}

// Dispatch routes a decoded envelope to the correct verb method.
// Unknown server-originated types and `error` frames are handled
// inside; verb errors propagate up to HandleFrame for logging.
func (s *Service) Dispatch(ctx context.Context, conn Conn, d *protocol.Decoded) error {
	return s.dispatch(ctx, conn, d)
}
