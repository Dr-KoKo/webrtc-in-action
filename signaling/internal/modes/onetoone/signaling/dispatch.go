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
// Server-originated message types (a client cannot legitimately
// send these) yield an `error` frame back. Client-sent `error`
// frames are logged and dropped.
func (s *Service) Dispatch(ctx context.Context, conn Conn, d *protocol.Decoded) error {
	switch d.Envelope.Type {
	case protocol.TypeJoinRoom:
		return s.handleJoinRoom(ctx, conn, d)
	case protocol.TypeLeaveRoom:
		return s.handleLeaveRoom(ctx, conn, d)
	case protocol.TypeMediaReady:
		return s.handleMediaReady(ctx, conn, d)
	case protocol.TypeMediaFailed:
		return s.handleMediaFailed(ctx, conn, d)
	case protocol.TypeOffer:
		return s.handleOffer(ctx, conn, d)
	case protocol.TypeAnswer:
		return s.handleAnswer(ctx, conn, d)
	case protocol.TypeIceCandidate:
		return s.handleIceCandidate(ctx, conn, d)
	case protocol.TypeMediaState:
		return s.handleMediaState(ctx, conn, d)
	case protocol.TypeReadyForOffer, protocol.TypeJoinAccepted, protocol.TypeJoinRejected,
		protocol.TypePeerPresenceChanged, protocol.TypePeerLeft, protocol.TypeParticipantReleased:
		// These are server-originated; a client sending them is a bug.
		s.writeError(ctx, conn, &protocol.DecodeError{
			Code:    protocol.CodeMalformed,
			Message: "server-originated message received from client",
		}, d.Envelope.RequestID)
		return nil
	case protocol.TypeError:
		// Clients may send `error` back to flag inbound-validation
		// failures. Log and drop — the server treats these as
		// informational.
		s.Log.Debug("client-reported error",
			slog.String("conn_id", conn.ID()),
		)
		return nil
	}
	return nil
}
