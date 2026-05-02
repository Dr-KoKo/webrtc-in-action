package signaling

import (
	"context"
	"log/slog"
	"time"

	"webrtc-lab/signaling/internal/modes/onetoone/protocol"
)

// handleIceCandidate validates the sender's state (contract §3.10 +
// data-model §C.2) and relays the payload bytes verbatim to the remote
// peer. Critically, the server NEVER parses `payload.candidate.candidate`
// — NFR-003, Principle III. Structured logs record counters only:
// `from_peer_id`, `to_peer_id`, `end_of_candidates`. Candidate strings,
// sdpMid, and sdpMLineIndex are NOT logged.
//
// The `candidate: ""` / missing-key malformed cases are already caught
// by protocol.IceCandidatePayload.Validate() (decoded before dispatch); a
// protocol.DecodeError(Code: protocol.CodeMalformed) flows through `writeError` to the
// sender without ever reaching this function.
func (s *Service) handleIceCandidate(ctx context.Context, conn Conn, d *protocol.Decoded) error {
	state := conn.State()
	if state.PeerID == "" {
		s.writeError(ctx, conn, &protocol.DecodeError{
			Code:    protocol.CodeNotInRoom,
			Message: "ice_candidate requires an admitted participant",
		}, d.Envelope.RequestID)
		return nil
	}
	rm := s.Rooms.Room(state.RoomID)
	if rm == nil {
		s.writeError(ctx, conn, &protocol.DecodeError{
			Code:    protocol.CodeNotInRoom,
			Message: "room not found",
		}, d.Envelope.RequestID)
		return nil
	}

	rm.Lock()
	p := rm.FindByPeerID(state.PeerID)
	if p == nil {
		rm.Unlock()
		s.writeError(ctx, conn, &protocol.DecodeError{
			Code:    protocol.CodeNotInRoom,
			Message: "participant not found",
		}, d.Envelope.RequestID)
		return nil
	}
	// §3.10 truth table: either peer may send trickle candidates while
	// media-ready and in role-assigned / negotiating / connected.
	role := rm.AssignedRole(state.PeerID)
	if relayErr := p.CanSendIceCandidate(role); relayErr != nil {
		rm.Unlock()
		s.writeError(ctx, conn, &protocol.DecodeError{
			Code:    protocol.ErrorCode(relayErr.Code),
			Message: relayErr.Message,
		}, d.Envelope.RequestID)
		return nil
	}
	remote := rm.ResolveRemote(state.PeerID)
	if remote == nil {
		rm.Unlock()
		s.writeError(ctx, conn, &protocol.DecodeError{
			Code:    protocol.CodeNotInRoom,
			Message: "remote peer not present",
		}, d.Envelope.RequestID)
		return nil
	}
	remoteConn := remote.Conn
	remotePeerID := remote.PeerID
	rm.Unlock()

	// Relay payload bytes verbatim. `d.Envelope.Payload` is a
	// `json.RawMessage` captured BEFORE decodePayload ran, so it still
	// carries the original `candidate` / `candidate: null` body without
	// any server-side parsing. NFR-003.
	outEnv := protocol.Envelope{
		V:       protocol.ContractVersion,
		Type:    protocol.TypeIceCandidate,
		RoomID:  state.RoomID,
		From:    state.PeerID,
		To:      remotePeerID,
		TS:      time.Now().UnixMilli(),
		Payload: d.Envelope.Payload,
	}
	if remoteConn == nil {
		s.writeError(ctx, conn, &protocol.DecodeError{
			Code:    protocol.CodeNotInRoom,
			Message: "remote peer not present",
		}, d.Envelope.RequestID)
		return nil
	}
	if err := remoteConn.SendJSON(remoteConn.BaseContext(), outEnv); err != nil {
		// Write failed — ICE is best-effort for protocol purposes but
		// the structured log must still reflect reality. Emit the
		// warning, do NOT fall through to the "relayed" success line.
		s.Log.Warn("ice_candidate relay failed",
			slog.String("peer_id", remotePeerID),
			slog.String("error", err.Error()))
		return nil
	}

	// `payload.Candidate == nil` here means end-of-candidates. Derive
	// the boolean from the already-decoded payload so we do not re-parse
	// the raw body. The decoded payload cannot be nil at this point —
	// decodePayload has already populated it — but guard defensively.
	endOfCandidates := false
	if payload, ok := d.Message.(*protocol.IceCandidatePayload); ok && payload != nil {
		endOfCandidates = payload.Candidate == nil
	}
	s.Log.Info("ice_candidate relayed",
		slog.String("event", "ice_candidate_relay"),
		slog.String("from_peer_id", state.PeerID),
		slog.String("to_peer_id", remotePeerID),
		slog.Bool("end_of_candidates", endOfCandidates),
	)
	return nil
}
