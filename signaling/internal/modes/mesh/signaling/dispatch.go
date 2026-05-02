package signaling

import (
	"context"
	"errors"
	"log/slog"

	"webrtc-lab/signaling/internal/modes/mesh/protocol"
)

// HandleFrame is the single entry point invoked by the per-conn
// SessionHandler in the mode root. It decodes the inbound v2
// envelope, writes a typed `error` frame back on decode failure,
// and otherwise hands the decoded value to Dispatch. Returns nil to
// keep the read loop alive on non-fatal protocol errors — a
// malformed frame is logged + answered with an `error` envelope but
// does not tear the WebSocket down.
func (s *Service) HandleFrame(ctx context.Context, conn Conn, frame []byte) error {
	decoded, derr := protocol.DecodeEnvelope(frame)
	if derr != nil {
		var perr *protocol.ProtocolError
		errors.As(derr, &perr)
		s.writeError(ctx, conn, perr, "")
		s.Log.Debug("mesh decode error",
			slog.String("conn_id", conn.ID()),
			slog.String("code", string(perr.Code)),
		)
		return nil
	}
	if err := s.Dispatch(ctx, conn, decoded); err != nil {
		s.Log.Debug("mesh dispatch error",
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
	case protocol.TypePairOffer:
		return s.handlePairOffer(ctx, conn, d)
	case protocol.TypePairAnswer:
		return s.handlePairAnswer(ctx, conn, d)
	case protocol.TypePairIceCandidate:
		return s.handlePairIceCandidate(ctx, conn, d)
	case protocol.TypePairMediaState:
		return s.handlePairMediaState(ctx, conn, d)
	case protocol.TypePairFailed:
		return s.handlePairFailed(ctx, conn, d)
	case protocol.TypeReconnectPair:
		return s.handleReconnectPair(ctx, conn, d)
	case protocol.TypeError:
		// Clients may send `error` back as informational; log + drop.
		s.Log.Debug("mesh client error reported",
			slog.String("conn_id", conn.ID()),
		)
		return nil
	case protocol.TypeJoinAccepted, protocol.TypeJoinRejected, protocol.TypeMeshRosterSnapshot,
		protocol.TypeMeshRosterUpdate, protocol.TypeParticipantReleased, protocol.TypePairNegotiationInstruction,
		protocol.TypePairReconnectInstruction, protocol.TypePeerLeft:
		// Server-originated types are protocol violations from a client.
		s.writeError(ctx, conn, &protocol.ProtocolError{
			Code:    protocol.CodeMalformed,
			Message: "server-originated message received from client",
		}, d.Envelope.RequestID)
		return nil
	default:
		s.writeError(ctx, conn, &protocol.ProtocolError{
			Code:    protocol.CodeInternalError,
			Message: string(d.Envelope.Type) + " is not yet wired in this milestone",
		}, d.Envelope.RequestID)
		return nil
	}
}
