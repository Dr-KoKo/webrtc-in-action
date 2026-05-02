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

	"webrtc-lab/signaling/internal/modes/mesh/protocol"
	"webrtc-lab/signaling/internal/modes/mesh/room"
	"webrtc-lab/signaling/internal/modes/mesh/signaling"
	"webrtc-lab/signaling/internal/shared/config"
	"webrtc-lab/signaling/internal/shared/heartbeat"
	"webrtc-lab/signaling/internal/shared/wsserver"
)

// Handler is the `/ws/mesh` upgrader for the 002 mesh contract. It
// owns the room manager and ICE config; the WebSocket session
// lifecycle (Accept, conn-id, heartbeat, read loop, write mutex,
// error classification, teardown) lives in
// internal/shared/wsserver. Mesh-specific state (admission, roster,
// pair negotiation) lives on SessionMesh below — that's the lesson.
//
// NewHandler returns *Handler so existing tests that reach
// h.Manager (mesh_roster_test.go:206) and mutate h.Heartbeat
// (lifecycle_test.go) continue to work. The wsserver Config holds
// &h.Heartbeat so post-construction mutations reach the running
// server.
type Handler struct {
	Log           *slog.Logger
	Heartbeat     heartbeat.Config
	Manager       *room.RoomManager
	AcceptOptions *websocket.AcceptOptions

	// IceServers is the v2 RTCIceServer list relayed in
	// `join_accepted`, `pair_negotiation_instruction`, and
	// `pair_reconnect_instruction`. Loaded once at construction from
	// env; never logged (TURN credentials are secrets per NFR-003).
	IceServers []protocol.IceServer

	service *signaling.Service
	server  *wsserver.Server
}

// NewHandler returns a Handler with sensible defaults loaded from
// env. The heartbeat defaults match 001 (5 s + 5 s) so SC-005a's
// ≤10 s detection bound is satisfied by construction.
func NewHandler(log *slog.Logger) *Handler {
	if log == nil {
		log = slog.Default()
	}
	ice := iceServersFromConfig(config.LoadIceServersFromEnv())
	if len(ice) == 0 {
		// Mesh contract §3.2 + §3.9 require iceServers non-empty.
		// Default to the public Google STUN entry so a fresh clone
		// works on localhost without a TURN configuration.
		ice = []protocol.IceServer{{URLs: []string{"stun:stun.l.google.com:19302"}}}
	}
	h := &Handler{
		Log:        log,
		Heartbeat:  heartbeat.LoadFromEnv(),
		Manager:    room.NewRoomManager(),
		IceServers: ice,
		AcceptOptions: &websocket.AcceptOptions{
			// Dev convenience: mirror 001's allow-any-origin policy
			// so the Vite dev server can connect through its `/ws`
			// proxy.
			InsecureSkipVerify: true,
		},
	}
	h.service = signaling.NewService(log, h.Manager, h.IceServers)
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
	return &SessionMesh{sess: sess, handler: h, log: log}, nil
}

// iceServersFromConfig converts the shared internal protocol.IceServer
// struct (no JSON tags) to this mode's wire-payload type with v2
// contract JSON tags.
func iceServersFromConfig(in []config.IceServer) []protocol.IceServer {
	out := make([]protocol.IceServer, len(in))
	for i, s := range in {
		out[i] = protocol.IceServer{
			URLs:       s.URLs,
			Username:   s.Username,
			Credential: s.Credential,
		}
	}
	return out
}

// SessionMesh is the per-WS mesh state. Implements both
// wsserver.SessionHandler (HandleFrame + OnDisconnect) AND the
// mode-local mesh.Conn interface (SendJSON, used by the manager
// and roster code to fan out frames). Transport-level fields (the
// *websocket.Conn, write mutex, conn-id) live on the wrapped
// wsserver.Session.
type SessionMesh struct {
	sess     wsserver.Session
	handler  *Handler
	log      *slog.Logger
	peerID   string
	roomID   string
	released atomic.Bool
}

// SendJSON marshals v as a text frame and forwards to
// wsserver.Session, which serializes the write under its mutex.
// Marshal happens outside the lock — a marginal upside over the
// pre-refactor pattern.
func (c *SessionMesh) SendJSON(ctx context.Context, v any) error {
	raw, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return c.sess.Send(ctx, raw)
}

// ID returns the per-WS connection identifier assigned by wsserver.
func (c *SessionMesh) ID() string { return c.sess.ID() }

// CloseNormal sends a normal-closure frame with the given reason.
// Hides coder/websocket.StatusCode from the signaling layer.
func (c *SessionMesh) CloseNormal(reason string) error {
	return c.sess.Close(websocket.StatusNormalClosure, reason)
}

// BaseContext returns the per-session base context (cancelled at
// teardown). Async fan-outs (roster updates, peer_left, pair
// instructions) thread this ctx when writing to other sessions whose
// lifetime is unrelated to the caller's request ctx.
func (c *SessionMesh) BaseContext() context.Context { return c.sess.BaseContext() }

// State returns a snapshot of the per-conn join/release state.
// Returned by value so the caller cannot mutate the session
// indirectly.
func (c *SessionMesh) State() signaling.ConnState {
	return signaling.ConnState{
		PeerID:   c.peerID,
		RoomID:   c.roomID,
		Released: c.released.Load(),
	}
}

// MarkJoined records the peerID/roomID pair after the room manager
// admits this connection. Called once per successful admission
// before any verb fires.
func (c *SessionMesh) MarkJoined(peerID, roomID string) {
	c.peerID = peerID
	c.roomID = roomID
}

// ClearJoined wipes the joined identifiers after release. Must
// only be called after a successful ReleaseOnce; the ordering is
// codified in specs/signaling-architecture.md §3.4.
func (c *SessionMesh) ClearJoined() {
	c.peerID = ""
	c.roomID = ""
}

// ReleaseOnce atomically transitions released from false to true.
// Returns true on the first call (the caller has claimed cleanup
// duty), false thereafter. Replaces the pre-refactor pattern of
// `if !released.Load() { releaseAndNotify; released.Store(true) }`
// with a TOCTOU-free single CAS.
func (c *SessionMesh) ReleaseOnce() bool {
	return c.released.CompareAndSwap(false, true)
}

// ResetReleaseLatch flips released back to false so a subsequent
// disconnect on the SAME connection (e.g. after a media_failed
// retry) still triggers cleanup. The only valid call site is the
// media_failed retry path; calling it elsewhere re-arms a latch
// that does not need re-arming.
func (c *SessionMesh) ResetReleaseLatch() { c.released.Store(false) }

// HandleFrame is the wsserver-side dispatch entry point. Decodes
// the v2 envelope; on decode failure writes a typed `error` frame
// back, logs the mesh-specific `code` field, and returns nil so
// the read loop continues. Dispatch errors are already surfaced to
// the client via writeError inside the per-type handlers; we log
// and return nil for the same continue-on-non-fatal reason.
func (c *SessionMesh) HandleFrame(ctx context.Context, frame []byte) error {
	decoded, derr := protocol.DecodeEnvelope(frame)
	if derr != nil {
		var perr *protocol.ProtocolError
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
// uses the domain reason protocol.RosterReasonDisconnect — preserving the
// pre-refactor handler.go:135 semantic where releaseAndNotify was
// always called with protocol.RosterReasonDisconnect for non-graceful exits
// (data-model §C.4). Returns nil attrs (matches pre-refactor
// disconnect log lines 140-144).
func (c *SessionMesh) OnDisconnect(transportReason string) []slog.Attr {
	_ = transportReason
	// releaseAndNotify uses ReleaseOnce internally so a graceful
	// leave_room and an ungraceful disconnect cannot both run cleanup.
	c.handler.releaseAndNotify(c, "disconnect", protocol.RosterReasonDisconnect)
	return nil
}

// writeError sends a typed `error` envelope back to the originating
// peer. Used both for envelope decode failures and for state-level
// rejections (M3+).
func (h *Handler) writeError(ctx context.Context, cc *SessionMesh, perr *protocol.ProtocolError, correlates string) {
	payload, _ := json.Marshal(protocol.ErrorPayload{
		Code:       perr.Code,
		Message:    perr.Message,
		Correlates: correlates,
	})
	env := protocol.Envelope{
		V:       protocol.ContractVersion,
		Type:    protocol.TypeError,
		TS:      time.Now().UnixMilli(),
		Payload: payload,
	}
	_ = cc.SendJSON(ctx, env)
}

// dispatch routes a decoded envelope to the correct handler. M3+M5
// arms: join_room, leave_room, media_ready, media_failed, error (echo
// to log). M6+ extends the switch with pair handlers.
func (h *Handler) dispatch(ctx context.Context, cc *SessionMesh, d *protocol.Decoded) error {
	switch d.Envelope.Type {
	case protocol.TypeJoinRoom:
		return h.handleJoinRoom(ctx, cc, d)
	case protocol.TypeLeaveRoom:
		return h.handleLeaveRoom(ctx, cc, d)
	case protocol.TypeMediaReady:
		return h.handleMediaReady(ctx, cc, d)
	case protocol.TypeMediaFailed:
		return h.handleMediaFailed(ctx, cc, d)
	case protocol.TypePairOffer:
		return h.handlePairOffer(ctx, cc, d)
	case protocol.TypePairAnswer:
		return h.handlePairAnswer(ctx, cc, d)
	case protocol.TypePairIceCandidate:
		return h.handlePairIceCandidate(ctx, cc, d)
	case protocol.TypePairMediaState:
		return h.handlePairMediaState(ctx, cc, d)
	case protocol.TypePairFailed:
		return h.handlePairFailed(ctx, cc, d)
	case protocol.TypeReconnectPair:
		return h.handleReconnectPair(ctx, cc, d)
	case protocol.TypeError:
		// Clients may send `error` back as informational; log + drop.
		h.Log.Debug("mesh client error reported",
			slog.String("conn_id", cc.sess.ID()),
		)
		return nil
	case protocol.TypeJoinAccepted, protocol.TypeJoinRejected, protocol.TypeMeshRosterSnapshot,
		protocol.TypeMeshRosterUpdate, protocol.TypeParticipantReleased, protocol.TypePairNegotiationInstruction,
		protocol.TypePairReconnectInstruction, protocol.TypePeerLeft:
		// Server-originated types are protocol violations from a client.
		h.writeError(ctx, cc, &protocol.ProtocolError{
			Code:    protocol.CodeMalformed,
			Message: "server-originated message received from client",
		}, d.Envelope.RequestID)
		return nil
	default:
		// Types reserved for later milestones. M6 (T049) wires
		// pair_offer + pair_answer; pair_ice_candidate waits for M7
		// (T055); pair_media_state landed in M9 (T071); pair_failed +
		// reconnect_pair for M11. Until each handler lands, reply
		// with internal_error per §3.19 — the request was understood
		// (decode passed) but the server has no implementation yet.
		// Using `not_in_room` here would be misleading because the
		// peer IS in the room; the failure is server-side.
		h.writeError(ctx, cc, &protocol.ProtocolError{
			Code:    protocol.CodeInternalError,
			Message: string(d.Envelope.Type) + " is not yet wired in this milestone",
		}, d.Envelope.RequestID)
		return nil
	}
}

// handleJoinRoom implements §3.1 + §3.2 + §3.3 + §3.4.
func (h *Handler) handleJoinRoom(ctx context.Context, cc *SessionMesh, d *protocol.Decoded) error {
	if cc.peerID != "" {
		h.writeError(ctx, cc, &protocol.ProtocolError{
			Code:    protocol.CodeAlreadyJoined,
			Message: "this connection has already joined a mesh room",
		}, d.Envelope.RequestID)
		return nil
	}
	// Contract §1.1: trim surrounding whitespace before validation.
	// Done at handler entry rather than inside protocol.ValidateRoomID so the
	// validator stays a pure regex check; trimmed value is used for
	// every downstream lookup so "demo " and "demo" map to the same
	// room.Room.
	roomID := strings.TrimSpace(d.Envelope.RoomID)
	if err := protocol.ValidateRoomID(roomID); err != nil {
		h.sendJoinRejected(ctx, cc, roomID, d.Envelope.RequestID,
			protocol.JoinRejectedInvalidRoom, protocol.ReasonInvalidRoomID,
			"Room ID must match ^[A-Za-z0-9._-]{1,64}$.")
		return nil
	}
	outcome := h.Manager.JoinOrCreate(roomID, cc)
	switch outcome.Result {
	case room.JoinRejectedRoomFullRes:
		h.sendJoinRejected(ctx, cc, roomID, d.Envelope.RequestID,
			protocol.JoinRejectedRoomFull, protocol.ReasonRoomFull,
			"Mesh room '"+roomID+"' already has 4 reserved participants.")
		return nil
	case room.JoinAccepted:
		cc.MarkJoined(outcome.Participant.PeerID, roomID)
		// Reset the disconnect-cleanup latch so a future ungraceful
		// close on this WS triggers `releaseAndNotify` for the freshly
		// admitted participant. Important when the user retries after
		// a `media_failed` release.
		cc.ResetReleaseLatch()
	}

	// join_accepted (§3.2)
	acceptPayload, _ := json.Marshal(protocol.JoinAcceptedPayload{
		PeerID:         outcome.Participant.PeerID,
		AdmissionIndex: outcome.Participant.AdmissionIndex,
		IceServers:     h.IceServers,
	})
	if err := cc.SendJSON(ctx, protocol.Envelope{
		V:         protocol.ContractVersion,
		Type:      protocol.TypeJoinAccepted,
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
	if err := cc.SendJSON(ctx, protocol.Envelope{
		V:       protocol.ContractVersion,
		Type:    protocol.TypeMeshRosterSnapshot,
		RoomID:  roomID,
		TS:      time.Now().UnixMilli(),
		Payload: snapshotPayload,
	}); err != nil {
		h.Log.Warn("mesh_roster_snapshot send failed",
			slog.String("conn_id", cc.sess.ID()), slog.String("error", err.Error()))
	}

	// mesh_roster_update (§3.5) — broadcast presence:joined to ALL
	// participants in the room INCLUDING the subject.
	h.broadcastRosterUpdate(rm, outcome.Participant, protocol.PresenceJoined, protocol.RosterReasonAdmitted)

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
func (h *Handler) handleLeaveRoom(ctx context.Context, cc *SessionMesh, d *protocol.Decoded) error {
	if cc.peerID == "" {
		h.writeError(ctx, cc, &protocol.ProtocolError{
			Code:    protocol.CodeNotInRoom,
			Message: "leave_room requires an admitted participant",
		}, d.Envelope.RequestID)
		return nil
	}
	h.releaseAndNotify(cc, "graceful_leave", protocol.RosterReasonGracefulLeave)
	cc.ClearJoined()
	_ = cc.CloseNormal("graceful_leave")
	return nil
}

// releaseAndNotify is the canonical disconnect path (data-model §C.4).
// Frees the slot, broadcasts mesh_roster_update presence:left to any
// remaining participants, and (for in-call leavers — readiness >=
// media-ready at the moment of release) ALSO emits a `peer_left`
// envelope to remaining peers so each client can tear down its
// PairContext for the leaver via Path B (M12 / T092). Idempotent via
// cc.released so the deferred ServeHTTP cleanup and an explicit
// leave_room don't double-emit.
//
// FR-025 / Path B isolation: the server MUST NOT broadcast a
// room-wide failed presence here. The leaver presence is `left`; each
// remaining client closes ONLY the pair local↔leaver, leaving healthy
// pairs alone.
func (h *Handler) releaseAndNotify(cc *SessionMesh, reason string, rosterReason protocol.RosterReason) {
	state := cc.State()
	if state.PeerID == "" {
		return
	}
	// Atomically claim the cleanup. If a graceful leave_room and an
	// ungraceful disconnect race, only the first caller proceeds; the
	// second observes ReleaseOnce()=false and returns. Replaces the
	// pre-refactor `Released-check + Store(true)-after-Release` pattern
	// with a single CAS, closing the TOCTOU window.
	if !cc.ReleaseOnce() {
		return
	}
	// Snapshot the readiness BEFORE Release frees the slot (Release
	// drops the participant from the room's map so a post-release lookup
	// would return nil). Used to gate `peer_left` emission below: only
	// in-call leavers (media-ready) had pairs that need teardown.
	departingReadiness := h.peerReadiness(state.RoomID, state.PeerID)
	outcome := h.Manager.Release(state.RoomID, state.PeerID)
	if outcome.Departing == nil {
		return
	}
	rm := outcome.Room
	rm.Lock()
	update := BuildRosterUpdate(rm, outcome.Departing, protocol.PresenceLeft, rosterReason)
	rm.Unlock()
	updatePayload, _ := json.Marshal(update)
	rosterEnv := protocol.Envelope{
		V:       protocol.ContractVersion,
		Type:    protocol.TypeMeshRosterUpdate,
		RoomID:  rm.ID(),
		TS:      time.Now().UnixMilli(),
		Payload: updatePayload,
	}

	// Build `peer_left` only for in-call leavers (readiness was
	// media-ready at the moment of release). A `joined`-state leaver
	// had no pairs yet, so the roster `left` update alone is enough.
	var peerLeftEnv *protocol.Envelope
	if departingReadiness == room.ReadinessMediaReady {
		peerLeftReason := protocol.PeerLeftDisconnect
		if rosterReason == protocol.RosterReasonGracefulLeave {
			peerLeftReason = protocol.PeerLeftGracefulLeave
		}
		peerLeftPayload, _ := json.Marshal(protocol.PeerLeftPayload{
			PeerID: outcome.Departing.PeerID,
			Reason: peerLeftReason,
		})
		peerLeftEnv = &protocol.Envelope{
			V:       protocol.ContractVersion,
			Type:    protocol.TypePeerLeft,
			RoomID:  rm.ID(),
			TS:      time.Now().UnixMilli(),
			Payload: peerLeftPayload,
		}
	}

	for _, p := range outcome.Remaining {
		if p.Conn == nil {
			continue
		}
		if err := p.Conn.SendJSON(p.Conn.BaseContext(), rosterEnv); err != nil {
			h.Log.Warn("mesh_roster_update send failed",
				slog.String("peer_id", p.PeerID),
				slog.String("error", err.Error()))
		}
		if peerLeftEnv != nil {
			if err := p.Conn.SendJSON(p.Conn.BaseContext(), *peerLeftEnv); err != nil {
				h.Log.Warn("peer_left send failed",
					slog.String("peer_id", p.PeerID),
					slog.String("error", err.Error()))
			}
		}
	}
	h.Log.Info("mesh peer departed",
		slog.String("event", "mesh_peer_departed"),
		slog.String("peer_id", cc.peerID),
		slog.String("room_id", cc.roomID),
		slog.String("reason", reason),
		slog.String("departing_readiness", string(departingReadiness)),
		slog.Bool("peer_left_emitted", peerLeftEnv != nil),
		slog.Bool("room_gc", outcome.RoomGarbageCollected),
	)
}

// peerReadiness returns the current readiness for the named participant
// or empty string when the room or participant is unknown. Caller must
// NOT hold the room mutex; the helper acquires it.
func (h *Handler) peerReadiness(roomID, peerID string) room.Readiness {
	rm := h.Manager.Room(roomID)
	if rm == nil {
		return ""
	}
	rm.Lock()
	defer rm.Unlock()
	p := rm.FindByPeerID(peerID)
	if p == nil {
		return ""
	}
	return p.Readiness
}

// broadcastRosterUpdate fans out a single mesh_roster_update to ALL
// participants in the room (including the subject). Caller does NOT
// hold the room lock — this method takes and releases it internally.
func (h *Handler) broadcastRosterUpdate(rm *room.Room, subject *room.Participant, presence protocol.Presence, reason protocol.RosterReason) {
	rm.Lock()
	update := BuildRosterUpdate(rm, subject, presence, reason)
	targets := rm.ParticipantsSnapshot()
	rm.Unlock()
	payload, _ := json.Marshal(update)
	env := protocol.Envelope{
		V:       protocol.ContractVersion,
		Type:    protocol.TypeMeshRosterUpdate,
		RoomID:  rm.ID(),
		TS:      time.Now().UnixMilli(),
		Payload: payload,
	}
	for _, p := range targets {
		if p.Conn == nil {
			continue
		}
		if err := p.Conn.SendJSON(p.Conn.BaseContext(), env); err != nil {
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
func (h *Handler) handleMediaReady(ctx context.Context, cc *SessionMesh, d *protocol.Decoded) error {
	if cc.peerID == "" {
		h.writeError(ctx, cc, &protocol.ProtocolError{
			Code:    protocol.CodeNotInRoom,
			Message: "media_ready requires an admitted participant",
		}, d.Envelope.RequestID)
		return nil
	}
	// decodeInto[protocol.MediaReadyPayload] already runs protocol.Validate() at decode
	// (protocol_media.go enforces audio=true && video=true). Re-check
	// here as belt-and-braces in case a future code path constructs a
	// protocol.Decoded without going through protocol.DecodeEnvelope. Split the
	// type-assertion failure (server-side decode mismatch) from the
	// capability mismatch (client contract violation) so each carries
	// the right error code.
	payload, ok := d.Message.(*protocol.MediaReadyPayload)
	if !ok || payload == nil {
		h.writeError(ctx, cc, &protocol.ProtocolError{
			Code:    protocol.CodeInternalError,
			Message: "media_ready decode mismatch",
		}, d.Envelope.RequestID)
		return nil
	}
	if !payload.MediaCapabilities.Audio || !payload.MediaCapabilities.Video {
		h.writeError(ctx, cc, &protocol.ProtocolError{
			Code:    protocol.CodeUnsupportedMediaCapability,
			Message: "media_ready requires audio=true AND video=true",
		}, d.Envelope.RequestID)
		return nil
	}
	rm := h.Manager.Room(cc.roomID)
	if rm == nil {
		h.writeError(ctx, cc, &protocol.ProtocolError{
			Code:    protocol.CodeNotInRoom,
			Message: "mesh room not found",
		}, d.Envelope.RequestID)
		return nil
	}
	rm.Lock()
	subject := rm.FindByPeerID(cc.peerID)
	if subject == nil {
		rm.Unlock()
		h.writeError(ctx, cc, &protocol.ProtocolError{
			Code:    protocol.CodeNotInRoom,
			Message: "participant not found in room",
		}, d.Envelope.RequestID)
		return nil
	}
	if subject.Readiness != room.ReadinessJoined {
		rm.Unlock()
		h.writeError(ctx, cc, &protocol.ProtocolError{
			Code:    protocol.CodeUnexpectedMediaReady,
			Message: "media_ready requires readiness=joined",
		}, d.Envelope.RequestID)
		return nil
	}
	subject.Readiness = room.ReadinessMediaReady
	subject.LastSeen = time.Now()
	rm.Unlock()

	// Broadcast roster update presence:media-ready (FR-012b).
	h.broadcastRosterUpdate(rm, subject, protocol.PresenceMediaReady, protocol.RosterReasonMediaReady)
	// room.Pair eligibility evaluator (T045 / §3.9). Emits one
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
func (h *Handler) handleMediaFailed(ctx context.Context, cc *SessionMesh, d *protocol.Decoded) error {
	if cc.peerID == "" {
		h.writeError(ctx, cc, &protocol.ProtocolError{
			Code:    protocol.CodeNotInRoom,
			Message: "media_failed requires an admitted participant",
		}, d.Envelope.RequestID)
		return nil
	}
	payload, _ := d.Message.(*protocol.MediaFailedPayload)
	detail := ""
	if payload != nil {
		detail = payload.Detail
	}

	// Step 1: release the slot (data-model §C.4). Captures the
	// remaining participants for the roster broadcast.
	outcome := h.Manager.Release(cc.roomID, cc.peerID)
	cc.ReleaseOnce()
	if outcome.Departing == nil {
		// Already released somehow — emit nothing (idempotent).
		return nil
	}
	rm := outcome.Room

	// Step 2: send `participant_released` to the failing peer
	// (the sender is still WS-connected; the user may Retry).
	releasedPayload, _ := json.Marshal(protocol.ParticipantReleasedPayload{
		Result: protocol.ParticipantReleasedMediaFailed,
		Reason: protocol.ReleasedReasonMediaFailed,
		Detail: detail,
	})
	releasedEnv := protocol.Envelope{
		V:       protocol.ContractVersion,
		Type:    protocol.TypeParticipantReleased,
		RoomID:  rm.ID(),
		TS:      time.Now().UnixMilli(),
		Payload: releasedPayload,
	}
	if err := cc.SendJSON(ctx, releasedEnv); err != nil {
		h.Log.Warn("participant_released send failed",
			slog.String("peer_id", cc.peerID),
			slog.String("error", err.Error()))
	}

	// Step 3: broadcast `mesh_roster_update { presence: "released" }`
	// to remaining participants. Caller already released the slot, so
	// `outcome.Remaining` is the post-release roster.
	rm.Lock()
	update := BuildRosterUpdate(rm, outcome.Departing, protocol.PresenceReleased, protocol.RosterReasonMediaFailed)
	rm.Unlock()
	updatePayload, _ := json.Marshal(update)
	updateEnv := protocol.Envelope{
		V:       protocol.ContractVersion,
		Type:    protocol.TypeMeshRosterUpdate,
		RoomID:  rm.ID(),
		TS:      time.Now().UnixMilli(),
		Payload: updatePayload,
	}
	for _, p := range outcome.Remaining {
		if p.Conn == nil {
			continue
		}
		if err := p.Conn.SendJSON(p.Conn.BaseContext(), updateEnv); err != nil {
			h.Log.Warn("mesh_roster_update send failed",
				slog.String("peer_id", p.PeerID),
				slog.String("error", err.Error()))
		}
	}

	// Local connCtx no longer references a participant. The WS stays
	// open so the user can Retry with a fresh `join_room` (contract
	// §3.8 client behavior).
	cc.ClearJoined()

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
func (h *Handler) sendJoinRejected(ctx context.Context, cc *SessionMesh, roomID, requestID string, result protocol.JoinRejectedResult, reason protocol.JoinRejectedReason, message string) {
	payload, _ := json.Marshal(protocol.JoinRejectedPayload{
		Result:  result,
		Reason:  reason,
		Message: message,
	})
	env := protocol.Envelope{
		V:         protocol.ContractVersion,
		Type:      protocol.TypeJoinRejected,
		RoomID:    roomID,
		RequestID: requestID,
		TS:        time.Now().UnixMilli(),
		Payload:   payload,
	}
	_ = cc.SendJSON(ctx, env)
}
