// Package mesh hosts the 002 multi-party mesh signaling endpoint
// (`/ws/mesh`). It is intentionally separate from the 001 `signaling`
// package so the 001 v1 codepath stays untouched (plan §6 preservation
// boundary). Cross-mode lookups are forbidden — the two registries
// share nothing.
//
// M1 scope: the handler accepts WebSocket upgrades, runs the same
// shared heartbeat (5 s ping + 5 s pong), and emits structured
// connect/disconnect log lines so an external smoke test can confirm
// the endpoint is reachable. M2+ extends this with envelope decode and
// dispatch.
package mesh

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"

	"webrtc-lab/signaling/internal/shared/config"
	"webrtc-lab/signaling/internal/shared/heartbeat"
	"webrtc-lab/signaling/internal/shared/wsserver"
)

// Handler is the `/ws/mesh` upgrader for the 002 mesh contract. It
// owns the room manager and ICE config; the WebSocket session
// lifecycle (Accept, conn-id, heartbeat, read loop, write mutex,
// error classification, teardown) lives in
// internal/shared/wsserver. Mesh-specific state (admission, roster,
// pair negotiation) lives on meshConn below — that's the lesson.
//
// NewHandler returns *Handler so existing tests that reach
// h.Manager (mesh_roster_test.go:206) and mutate h.Heartbeat
// (lifecycle_test.go) continue to work. The wsserver Config holds
// &h.Heartbeat so post-construction mutations reach the running
// server.
type Handler struct {
	Log           *slog.Logger
	Heartbeat     heartbeat.Config
	Manager       *MeshRoomManager
	AcceptOptions *websocket.AcceptOptions

	server *wsserver.Server
}

// NewHandler returns a Handler with sensible defaults loaded from
// env. The heartbeat defaults match 001 (5 s + 5 s) so SC-005a's
// ≤10 s detection bound is satisfied by construction.
func NewHandler(log *slog.Logger) *Handler {
	if log == nil {
		log = slog.Default()
	}
	h := &Handler{
		Log:       log,
		Heartbeat: heartbeat.LoadFromEnv(),
		Manager:   NewMeshRoomManager(ManagerConfig{IceServers: iceServersFromConfig(config.LoadIceServersFromEnv())}),
		AcceptOptions: &websocket.AcceptOptions{
			// Dev convenience: mirror 001's allow-any-origin policy
			// so the Vite dev server can connect through its `/ws`
			// proxy.
			InsecureSkipVerify: true,
		},
	}
	h.server = wsserver.New(h, wsserver.Config{
		Logger:          log,
		Heartbeat:       &h.Heartbeat,
		HeartbeatLabels: meshHeartbeatLabels,
		Accept:          h.AcceptOptions,
		ConnIDPrefix:    "m-",
		Connect:         wsserver.LogLine{Event: "mesh_ws_connected", Message: "mesh websocket connected"},
		Disconnect:      wsserver.LogLine{Event: "mesh_ws_disconnected", Message: "mesh websocket disconnected"},
		AcceptFailed:    wsserver.LogLine{Event: "mesh_ws_accept_failed", Message: "mesh websocket accept failed"},
	})
	return h
}

// ServeHTTP delegates to the wsserver.Server built at NewHandler
// time. The transport plumbing lives there so this file opens with
// the mesh lesson — admission, roster fan-out, pair negotiation —
// instead of WebSocket bookkeeping.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.server.ServeHTTP(w, r)
}

// NewSession satisfies wsserver.Mode — one call per accepted WS.
func (h *Handler) NewSession(sess wsserver.Session, log *slog.Logger) (wsserver.SessionHandler, error) {
	return &meshConn{sess: sess, handler: h, log: log}, nil
}

// iceServersFromConfig converts the shared internal IceServer
// struct (no JSON tags) to this mode's wire-payload type with v2
// contract JSON tags.
func iceServersFromConfig(in []config.IceServer) []IceServer {
	out := make([]IceServer, len(in))
	for i, s := range in {
		out[i] = IceServer{
			URLs:       s.URLs,
			Username:   s.Username,
			Credential: s.Credential,
		}
	}
	return out
}

// meshConn is the per-WS mesh state. Implements both
// wsserver.SessionHandler (HandleFrame + OnDisconnect) AND the
// mode-local mesh.Conn interface (SendJSON, used by the manager
// and roster code to fan out frames). Transport-level fields (the
// *websocket.Conn, write mutex, conn-id) live on the wrapped
// wsserver.Session.
type meshConn struct {
	sess     wsserver.Session
	handler  *Handler
	log      *slog.Logger
	peerID   string
	roomID   string
	released atomic.Bool
}

// sendJSON marshals v as a text frame and forwards to
// wsserver.Session, which serializes the write under its mutex.
// Marshal happens outside the lock — a marginal upside over the
// pre-refactor pattern.
func (c *meshConn) sendJSON(ctx context.Context, v any) error {
	raw, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return c.sess.Send(ctx, raw)
}

// SendJSON satisfies mesh.Conn so the manager + roster helpers can
// fan out frames to a participant without depending on coder/websocket.
// Uses the per-session base context (cancelled at teardown) — same
// semantic as the pre-refactor connCtx.baseCtx field.
func (c *meshConn) SendJSON(v any) error {
	return c.sendJSON(c.sess.BaseContext(), v)
}

// HandleFrame is the wsserver-side dispatch entry point. Decodes
// the v2 envelope; on decode failure writes a typed `error` frame
// back, logs the mesh-specific `code` field, and returns nil so
// the read loop continues. Dispatch errors are already surfaced to
// the client via writeError inside the per-type handlers; we log
// and return nil for the same continue-on-non-fatal reason.
func (c *meshConn) HandleFrame(ctx context.Context, frame []byte) error {
	decoded, derr := DecodeEnvelope(frame)
	if derr != nil {
		var perr *ProtocolError
		errors.As(derr, &perr)
		c.handler.writeError(ctx, c, perr, "")
		c.handler.Log.Debug("mesh decode error",
			slog.String("conn_id", c.sess.ID()),
			slog.String("code", string(perr.Code)),
		)
		return nil
	}
	if err := c.handler.dispatch(ctx, c, decoded); err != nil {
		c.handler.Log.Debug("mesh dispatch error",
			slog.String("conn_id", c.sess.ID()),
			slog.String("type", string(decoded.Envelope.Type)),
			slog.String("error", err.Error()),
		)
	}
	return nil
}

// OnDisconnect runs once during teardown. The transportReason
// argument names the wire-level cause (peer_close / read_error /
// etc.) but is intentionally NOT forwarded to room cleanup, which
// uses the domain reason RosterReasonDisconnect — preserving the
// pre-refactor handler.go:135 semantic where releaseAndNotify was
// always called with RosterReasonDisconnect for non-graceful exits
// (data-model §C.4). Returns nil attrs (matches pre-refactor
// disconnect log lines 140-144).
func (c *meshConn) OnDisconnect(transportReason string) []slog.Attr {
	_ = transportReason
	if c.peerID != "" && !c.released.Load() {
		c.handler.releaseAndNotify(c, "disconnect", RosterReasonDisconnect)
	}
	return nil
}

// writeError sends a typed `error` envelope back to the originating
// peer. Used both for envelope decode failures and for state-level
// rejections (M3+).
func (h *Handler) writeError(ctx context.Context, cc *meshConn, perr *ProtocolError, correlates string) {
	payload, _ := json.Marshal(ErrorPayload{
		Code:       perr.Code,
		Message:    perr.Message,
		Correlates: correlates,
	})
	env := Envelope{
		V:       ContractVersion,
		Type:    TypeError,
		TS:      time.Now().UnixMilli(),
		Payload: payload,
	}
	_ = cc.sendJSON(ctx, env)
}

// dispatch routes a decoded envelope to the correct handler. M3+M5
// arms: join_room, leave_room, media_ready, media_failed, error (echo
// to log). M6+ extends the switch with pair handlers.
func (h *Handler) dispatch(ctx context.Context, cc *meshConn, d *Decoded) error {
	switch d.Envelope.Type {
	case TypeJoinRoom:
		return h.handleJoinRoom(ctx, cc, d)
	case TypeLeaveRoom:
		return h.handleLeaveRoom(ctx, cc, d)
	case TypeMediaReady:
		return h.handleMediaReady(ctx, cc, d)
	case TypeMediaFailed:
		return h.handleMediaFailed(ctx, cc, d)
	case TypePairOffer:
		return h.handlePairOffer(ctx, cc, d)
	case TypePairAnswer:
		return h.handlePairAnswer(ctx, cc, d)
	case TypeError:
		// Clients may send `error` back as informational; log + drop.
		h.Log.Debug("mesh client error reported",
			slog.String("conn_id", cc.sess.ID()),
		)
		return nil
	case TypeJoinAccepted, TypeJoinRejected, TypeMeshRosterSnapshot,
		TypeMeshRosterUpdate, TypeParticipantReleased, TypePairNegotiationInstruction,
		TypePairReconnectInstruction, TypePeerLeft:
		// Server-originated types are protocol violations from a client.
		h.writeError(ctx, cc, &ProtocolError{
			Code:    CodeMalformed,
			Message: "server-originated message received from client",
		}, d.Envelope.RequestID)
		return nil
	default:
		// Types reserved for later milestones. M6 (T049) wires
		// pair_offer + pair_answer; pair_ice_candidate waits for M7
		// (T055), pair_media_state for M9 (T071), pair_failed +
		// reconnect_pair for M11. Until each handler lands, reply
		// with internal_error per §3.19 — the request was understood
		// (decode passed) but the server has no implementation yet.
		// Using `not_in_room` here would be misleading because the
		// peer IS in the room; the failure is server-side.
		h.writeError(ctx, cc, &ProtocolError{
			Code:    CodeInternalError,
			Message: string(d.Envelope.Type) + " is not yet wired in this milestone",
		}, d.Envelope.RequestID)
		return nil
	}
}

// handleJoinRoom implements §3.1 + §3.2 + §3.3 + §3.4.
func (h *Handler) handleJoinRoom(ctx context.Context, cc *meshConn, d *Decoded) error {
	if cc.peerID != "" {
		h.writeError(ctx, cc, &ProtocolError{
			Code:    CodeAlreadyJoined,
			Message: "this connection has already joined a mesh room",
		}, d.Envelope.RequestID)
		return nil
	}
	// Contract §1.1: trim surrounding whitespace before validation.
	// Done at handler entry rather than inside ValidateRoomID so the
	// validator stays a pure regex check; trimmed value is used for
	// every downstream lookup so "demo " and "demo" map to the same
	// MeshRoom.
	roomID := strings.TrimSpace(d.Envelope.RoomID)
	if err := ValidateRoomID(roomID); err != nil {
		h.sendJoinRejected(ctx, cc, roomID, d.Envelope.RequestID,
			JoinRejectedInvalidRoom, ReasonInvalidRoomID,
			"Room ID must match ^[A-Za-z0-9._-]{1,64}$.")
		return nil
	}
	outcome := h.Manager.JoinOrCreate(roomID, cc)
	switch outcome.Result {
	case JoinRejectedInvalidRoom2:
		h.sendJoinRejected(ctx, cc, roomID, d.Envelope.RequestID,
			JoinRejectedInvalidRoom, ReasonInvalidRoomID,
			"Room ID must match ^[A-Za-z0-9._-]{1,64}$.")
		return nil
	case JoinRejectedRoomFullRes:
		h.sendJoinRejected(ctx, cc, roomID, d.Envelope.RequestID,
			JoinRejectedRoomFull, ReasonRoomFull,
			"Mesh room '"+roomID+"' already has 4 reserved participants.")
		return nil
	case JoinAccepted:
		cc.peerID = outcome.Participant.PeerID
		cc.roomID = roomID
		// Reset the disconnect-cleanup latch so a future ungraceful
		// close on this WS triggers `releaseAndNotify` for the freshly
		// admitted participant. Important when the user retries after
		// a `media_failed` release.
		cc.released.Store(false)
	}

	// join_accepted (§3.2)
	acceptPayload, _ := json.Marshal(JoinAcceptedPayload{
		PeerID:         outcome.Participant.PeerID,
		AdmissionIndex: outcome.Participant.AdmissionIndex,
		IceServers:     h.Manager.IceServers(),
	})
	if err := cc.sendJSON(ctx, Envelope{
		V:         ContractVersion,
		Type:      TypeJoinAccepted,
		RoomID:    roomID,
		RequestID: d.Envelope.RequestID,
		TS:        time.Now().UnixMilli(),
		Payload:   acceptPayload,
	}); err != nil {
		h.Log.Warn("mesh join_accepted send failed",
			slog.String("conn_id", cc.sess.ID()), slog.String("error", err.Error()))
	}

	// mesh_roster_snapshot (§3.4) — sent immediately after join_accepted.
	rm := outcome.Room
	rm.Lock()
	snapshot := BuildRosterSnapshot(rm)
	rm.Unlock()
	snapshotPayload, _ := json.Marshal(snapshot)
	if err := cc.sendJSON(ctx, Envelope{
		V:       ContractVersion,
		Type:    TypeMeshRosterSnapshot,
		RoomID:  roomID,
		TS:      time.Now().UnixMilli(),
		Payload: snapshotPayload,
	}); err != nil {
		h.Log.Warn("mesh_roster_snapshot send failed",
			slog.String("conn_id", cc.sess.ID()), slog.String("error", err.Error()))
	}

	// mesh_roster_update (§3.5) — broadcast presence:joined to ALL
	// participants in the room INCLUDING the subject.
	h.broadcastRosterUpdate(rm, outcome.Participant, PresenceJoined, RosterReasonAdmitted)

	h.Log.Info("mesh peer admitted",
		slog.String("event", "mesh_peer_admitted"),
		slog.String("conn_id", cc.sess.ID()),
		slog.String("peer_id", cc.peerID),
		slog.String("room_id", roomID),
		slog.Uint64("admission_index", outcome.Participant.AdmissionIndex),
	)
	return nil
}

// handleLeaveRoom implements §3.18.
func (h *Handler) handleLeaveRoom(ctx context.Context, cc *meshConn, d *Decoded) error {
	if cc.peerID == "" {
		h.writeError(ctx, cc, &ProtocolError{
			Code:    CodeNotInRoom,
			Message: "leave_room requires an admitted participant",
		}, d.Envelope.RequestID)
		return nil
	}
	h.releaseAndNotify(cc, "graceful_leave", RosterReasonGracefulLeave)
	cc.peerID = ""
	cc.roomID = ""
	_ = cc.sess.Close(websocket.StatusNormalClosure, "graceful_leave")
	return nil
}

// releaseAndNotify is the canonical disconnect path (data-model §C.4).
// Frees the slot, broadcasts mesh_roster_update presence:left to any
// remaining participants. Idempotent via cc.released so the deferred
// ServeHTTP cleanup and an explicit leave_room don't double-emit.
func (h *Handler) releaseAndNotify(cc *meshConn, reason string, rosterReason RosterReason) {
	if cc.released.Load() || cc.peerID == "" {
		return
	}
	outcome := h.Manager.Release(cc.roomID, cc.peerID)
	cc.released.Store(true)
	if outcome.Departing == nil {
		return
	}
	// Departing presence is `left` for both graceful leaves and
	// disconnects on this path; `released` is reserved for the
	// `media_failed` path in `handleMediaFailed`. M5+ may refine this
	// further once pair lifecycle lands.
	rm := outcome.Room
	rm.Lock()
	update := BuildRosterUpdate(rm, outcome.Departing, PresenceLeft, rosterReason)
	rm.Unlock()
	updatePayload, _ := json.Marshal(update)
	env := Envelope{
		V:       ContractVersion,
		Type:    TypeMeshRosterUpdate,
		RoomID:  rm.ID(),
		TS:      time.Now().UnixMilli(),
		Payload: updatePayload,
	}
	for _, p := range outcome.Remaining {
		if p.Conn == nil {
			continue
		}
		if err := p.Conn.SendJSON(env); err != nil {
			h.Log.Warn("mesh_roster_update send failed",
				slog.String("peer_id", p.PeerID),
				slog.String("error", err.Error()))
		}
	}
	h.Log.Info("mesh peer departed",
		slog.String("event", "mesh_peer_departed"),
		slog.String("peer_id", cc.peerID),
		slog.String("room_id", cc.roomID),
		slog.String("reason", reason),
		slog.Bool("room_gc", outcome.RoomGarbageCollected),
	)
}

// broadcastRosterUpdate fans out a single mesh_roster_update to ALL
// participants in the room (including the subject). Caller does NOT
// hold the room lock — this method takes and releases it internally.
func (h *Handler) broadcastRosterUpdate(rm *MeshRoom, subject *Participant, presence Presence, reason RosterReason) {
	rm.Lock()
	update := BuildRosterUpdate(rm, subject, presence, reason)
	targets := rm.ParticipantsSnapshot()
	rm.Unlock()
	payload, _ := json.Marshal(update)
	env := Envelope{
		V:       ContractVersion,
		Type:    TypeMeshRosterUpdate,
		RoomID:  rm.ID(),
		TS:      time.Now().UnixMilli(),
		Payload: payload,
	}
	for _, p := range targets {
		if p.Conn == nil {
			continue
		}
		if err := p.Conn.SendJSON(env); err != nil {
			h.Log.Warn("mesh_roster_update send failed",
				slog.String("peer_id", p.PeerID),
				slog.String("error", err.Error()))
		}
	}
}

// handleMediaReady implements §3.6. Transitions the participant
// readiness to media-ready and broadcasts the corresponding roster
// update. M5 stops here — pair instructions land in M6.
//
// Per data-model §A.3, media_ready arriving from a non-`joined`
// readiness is rejected with `error { code: "unexpected_media_ready" }`.
func (h *Handler) handleMediaReady(ctx context.Context, cc *meshConn, d *Decoded) error {
	if cc.peerID == "" {
		h.writeError(ctx, cc, &ProtocolError{
			Code:    CodeNotInRoom,
			Message: "media_ready requires an admitted participant",
		}, d.Envelope.RequestID)
		return nil
	}
	// decodeInto[MediaReadyPayload] already runs Validate() at decode
	// (protocol_media.go enforces audio=true && video=true). Re-check
	// here as belt-and-braces in case a future code path constructs a
	// Decoded without going through DecodeEnvelope. Split the
	// type-assertion failure (server-side decode mismatch) from the
	// capability mismatch (client contract violation) so each carries
	// the right error code.
	payload, ok := d.Message.(*MediaReadyPayload)
	if !ok || payload == nil {
		h.writeError(ctx, cc, &ProtocolError{
			Code:    CodeInternalError,
			Message: "media_ready decode mismatch",
		}, d.Envelope.RequestID)
		return nil
	}
	if !payload.MediaCapabilities.Audio || !payload.MediaCapabilities.Video {
		h.writeError(ctx, cc, &ProtocolError{
			Code:    CodeUnsupportedMediaCapability,
			Message: "media_ready requires audio=true AND video=true",
		}, d.Envelope.RequestID)
		return nil
	}
	rm := h.Manager.Room(cc.roomID)
	if rm == nil {
		h.writeError(ctx, cc, &ProtocolError{
			Code:    CodeNotInRoom,
			Message: "mesh room not found",
		}, d.Envelope.RequestID)
		return nil
	}
	rm.Lock()
	subject := rm.FindByPeerID(cc.peerID)
	if subject == nil {
		rm.Unlock()
		h.writeError(ctx, cc, &ProtocolError{
			Code:    CodeNotInRoom,
			Message: "participant not found in room",
		}, d.Envelope.RequestID)
		return nil
	}
	if subject.Readiness != ReadinessJoined {
		rm.Unlock()
		h.writeError(ctx, cc, &ProtocolError{
			Code:    CodeUnexpectedMediaReady,
			Message: "media_ready requires readiness=joined",
		}, d.Envelope.RequestID)
		return nil
	}
	subject.Readiness = ReadinessMediaReady
	subject.LastSeen = time.Now()
	rm.Unlock()

	// Broadcast roster update presence:media-ready (FR-012b).
	h.broadcastRosterUpdate(rm, subject, PresenceMediaReady, RosterReasonMediaReady)
	// Pair eligibility evaluator (T045 / §3.9). Emits one
	// `pair_negotiation_instruction` to each endpoint of every NEW
	// pair the subject formed with already-media-ready peers.
	h.EvaluateAndEmitInstructions(rm, subject)
	h.Log.Info("mesh peer media-ready",
		slog.String("event", "mesh_peer_media_ready"),
		slog.String("conn_id", cc.sess.ID()),
		slog.String("peer_id", cc.peerID),
		slog.String("room_id", cc.roomID),
	)
	return nil
}

// handleMediaFailed implements §3.7. Releases the sender's slot,
// emits `participant_released` to the sender, and broadcasts a
// `mesh_roster_update { presence: "released", reason: "media_failed" }`
// to the remaining participants. The admissionIndex value is preserved
// (data-model §A.4 — never reused).
func (h *Handler) handleMediaFailed(ctx context.Context, cc *meshConn, d *Decoded) error {
	if cc.peerID == "" {
		h.writeError(ctx, cc, &ProtocolError{
			Code:    CodeNotInRoom,
			Message: "media_failed requires an admitted participant",
		}, d.Envelope.RequestID)
		return nil
	}
	payload, _ := d.Message.(*MediaFailedPayload)
	detail := ""
	if payload != nil {
		detail = payload.Detail
	}

	// Step 1: release the slot (data-model §C.4). Captures the
	// remaining participants for the roster broadcast.
	outcome := h.Manager.Release(cc.roomID, cc.peerID)
	cc.released.Store(true)
	if outcome.Departing == nil {
		// Already released somehow — emit nothing (idempotent).
		return nil
	}
	rm := outcome.Room

	// Step 2: send `participant_released` to the failing peer
	// (the sender is still WS-connected; the user may Retry).
	releasedPayload, _ := json.Marshal(ParticipantReleasedPayload{
		Result: ParticipantReleasedMediaFailed,
		Reason: ReleasedReasonMediaFailed,
		Detail: detail,
	})
	releasedEnv := Envelope{
		V:       ContractVersion,
		Type:    TypeParticipantReleased,
		RoomID:  rm.ID(),
		TS:      time.Now().UnixMilli(),
		Payload: releasedPayload,
	}
	if err := cc.sendJSON(ctx, releasedEnv); err != nil {
		h.Log.Warn("participant_released send failed",
			slog.String("peer_id", cc.peerID),
			slog.String("error", err.Error()))
	}

	// Step 3: broadcast `mesh_roster_update { presence: "released" }`
	// to remaining participants. Caller already released the slot, so
	// `outcome.Remaining` is the post-release roster.
	rm.Lock()
	update := BuildRosterUpdate(rm, outcome.Departing, PresenceReleased, RosterReasonMediaFailed)
	rm.Unlock()
	updatePayload, _ := json.Marshal(update)
	updateEnv := Envelope{
		V:       ContractVersion,
		Type:    TypeMeshRosterUpdate,
		RoomID:  rm.ID(),
		TS:      time.Now().UnixMilli(),
		Payload: updatePayload,
	}
	for _, p := range outcome.Remaining {
		if p.Conn == nil {
			continue
		}
		if err := p.Conn.SendJSON(updateEnv); err != nil {
			h.Log.Warn("mesh_roster_update send failed",
				slog.String("peer_id", p.PeerID),
				slog.String("error", err.Error()))
		}
	}

	// Local connCtx no longer references a participant. The WS stays
	// open so the user can Retry with a fresh `join_room` (contract
	// §3.8 client behavior).
	cc.peerID = ""
	cc.roomID = ""

	h.Log.Info("mesh peer released (media_failed)",
		slog.String("event", "mesh_peer_released"),
		slog.String("conn_id", cc.sess.ID()),
		slog.String("peer_id", outcome.Departing.PeerID),
		slog.String("room_id", rm.ID()),
		slog.Bool("room_gc", outcome.RoomGarbageCollected),
	)
	return nil
}

// sendJoinRejected centralizes the join_rejected send.
func (h *Handler) sendJoinRejected(ctx context.Context, cc *meshConn, roomID, requestID string, result JoinRejectedResult, reason JoinRejectedReason, message string) {
	payload, _ := json.Marshal(JoinRejectedPayload{
		Result:  result,
		Reason:  reason,
		Message: message,
	})
	env := Envelope{
		V:         ContractVersion,
		Type:      TypeJoinRejected,
		RoomID:    roomID,
		RequestID: requestID,
		TS:        time.Now().UnixMilli(),
		Payload:   payload,
	}
	_ = cc.sendJSON(ctx, env)
}

