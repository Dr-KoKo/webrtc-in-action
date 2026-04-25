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
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

// Handler is the `/ws/mesh` upgrader + per-connection dispatcher.
//
// M3 scope: envelope decode, join_room → join_accepted +
// mesh_roster_snapshot + roster broadcast, leave_room cleanup, 5th
// rejection via join_rejected_room_full. Disconnect cleanup runs on
// read-loop exit and broadcasts mesh_roster_update presence:left to
// any remaining participants. ICE / SDP / DataChannel relay land in
// M5+.
type Handler struct {
	Log           *slog.Logger
	Heartbeat     HeartbeatConfig
	Manager       *MeshRoomManager
	AcceptOptions *websocket.AcceptOptions

	connSeq atomic.Uint64
}

// NewHandler returns a Handler with sensible defaults loaded from env.
// The heartbeat defaults match 001 (5 s + 5 s) so SC-005a's ≤10 s
// detection bound is satisfied by construction.
func NewHandler(log *slog.Logger) *Handler {
	if log == nil {
		log = slog.Default()
	}
	return &Handler{
		Log:       log,
		Heartbeat: LoadHeartbeatConfig(),
		Manager:   NewMeshRoomManager(ManagerConfig{IceServers: loadIceServersFromEnv()}),
		AcceptOptions: &websocket.AcceptOptions{
			// Dev convenience: mirror 001's allow-any-origin policy so the
			// Vite dev server can connect through its `/ws` proxy.
			InsecureSkipVerify: true,
		},
	}
}

// loadIceServersFromEnv reads VITE_STUN_URLS / VITE_TURN_* identical
// to the 001 server. The mesh and 001 endpoints share the same env
// keys so a single configuration governs both. The list is relayed to
// peers in `join_accepted` and per-pair instructions; TURN credentials
// MUST NEVER appear in logs (NFR-003).
func loadIceServersFromEnv() []IceServer {
	var servers []IceServer
	if raw := os.Getenv("VITE_STUN_URLS"); raw != "" {
		urls := splitAndTrim(raw, ",")
		if len(urls) > 0 {
			servers = append(servers, IceServer{URLs: urls})
		}
	}
	if len(servers) == 0 {
		servers = append(servers, IceServer{URLs: []string{"stun:stun.l.google.com:19302"}})
	}
	if turn := os.Getenv("VITE_TURN_URL"); turn != "" {
		servers = append(servers, IceServer{
			URLs:       []string{turn},
			Username:   os.Getenv("VITE_TURN_USERNAME"),
			Credential: os.Getenv("VITE_TURN_CREDENTIAL"),
		})
	}
	return servers
}

func splitAndTrim(s, sep string) []string {
	out := []string{}
	cur := ""
	for _, r := range s {
		if string(r) == sep {
			if t := strings.TrimSpace(cur); t != "" {
				out = append(out, t)
			}
			cur = ""
			continue
		}
		cur += string(r)
	}
	if t := strings.TrimSpace(cur); t != "" {
		out = append(out, t)
	}
	return out
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, h.AcceptOptions)
	if err != nil {
		h.Log.Warn("mesh websocket accept failed",
			slog.String("event", "mesh_ws_accept_failed"),
			slog.String("remote_addr", r.RemoteAddr),
			slog.String("error", err.Error()),
		)
		return
	}

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	cc := &connCtx{
		conn:    conn,
		connID:  formatConnID(h.connSeq.Add(1)),
		baseCtx: ctx,
	}
	h.Log.Info("mesh websocket connected",
		slog.String("event", "mesh_ws_connected"),
		slog.String("conn_id", cc.connID),
		slog.String("remote_addr", r.RemoteAddr),
	)

	heartbeatDone := make(chan error, 1)
	go func() {
		heartbeatDone <- runHeartbeat(ctx, conn, h.Heartbeat, h.Log, cc.connID)
	}()

	readErr := h.readLoop(ctx, cc)

	cancel()
	hbErr := <-heartbeatDone

	reason := "closed"
	switch {
	case readErr != nil:
		reason = classifyReadError(readErr)
	case hbErr != nil && !errors.Is(hbErr, context.Canceled):
		var herr *HeartbeatError
		if errors.As(hbErr, &herr) {
			reason = herr.Reason
		} else {
			reason = "heartbeat_error"
		}
	}

	// Disconnect cleanup (data-model §C.4): if the connection was
	// admitted and not already released by an explicit leave_room,
	// release the slot and broadcast mesh_roster_update presence:left.
	if cc.peerID != "" && !cc.released.Load() {
		h.releaseAndNotify(cc, "disconnect", RosterReasonDisconnect)
	}

	_ = conn.Close(websocket.StatusNormalClosure, "bye")

	h.Log.Info("mesh websocket disconnected",
		slog.String("event", "mesh_ws_disconnected"),
		slog.String("conn_id", cc.connID),
		slog.String("reason", reason),
	)
}

// connCtx carries per-WS mutable state. The writeMu serializes all
// outbound writes against the shared websocket.Conn (which is not
// concurrency-safe for writes). connCtx implements the mesh.Conn
// interface via SendJSON below so the manager / room can broadcast
// without depending on coder/websocket.
type connCtx struct {
	conn     *websocket.Conn
	writeMu  sync.Mutex
	connID   string
	peerID   string
	roomID   string
	released atomic.Bool
	// baseCtx is the request context captured at ServeHTTP entry; used
	// by SendJSON when the manager broadcasts outside the read loop's
	// own ctx.
	baseCtx context.Context
}

func (c *connCtx) sendJSON(ctx context.Context, v any) error {
	raw, err := json.Marshal(v)
	if err != nil {
		return err
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	writeCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	return c.conn.Write(writeCtx, websocket.MessageText, raw)
}

// SendJSON satisfies mesh.Conn so the manager + roster helpers can
// fan out frames to a participant without importing coder/websocket.
func (c *connCtx) SendJSON(v any) error {
	return c.sendJSON(c.baseCtx, v)
}

// writeError sends a typed `error` envelope back to the originating
// peer. Used both for envelope decode failures and for state-level
// rejections (M3+).
func (h *Handler) writeError(ctx context.Context, cc *connCtx, perr *ProtocolError, correlates string) {
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

// readLoop decodes inbound mesh envelopes and routes to dispatch.
func (h *Handler) readLoop(ctx context.Context, cc *connCtx) error {
	for {
		_, raw, err := cc.conn.Read(ctx)
		if err != nil {
			return err
		}
		decoded, derr := DecodeEnvelope(raw)
		if derr != nil {
			var perr *ProtocolError
			errors.As(derr, &perr)
			h.writeError(ctx, cc, perr, "")
			h.Log.Debug("mesh decode error",
				slog.String("conn_id", cc.connID),
				slog.String("code", string(perr.Code)),
			)
			continue
		}
		if err := h.dispatch(ctx, cc, decoded); err != nil {
			h.Log.Debug("mesh dispatch error",
				slog.String("conn_id", cc.connID),
				slog.String("type", string(decoded.Envelope.Type)),
				slog.String("error", err.Error()),
			)
		}
	}
}

// dispatch routes a decoded envelope to the correct handler. M3
// arms: join_room, leave_room, error (echo to log). Future milestones
// extend the switch with media + pair handlers.
func (h *Handler) dispatch(ctx context.Context, cc *connCtx, d *Decoded) error {
	switch d.Envelope.Type {
	case TypeJoinRoom:
		return h.handleJoinRoom(ctx, cc, d)
	case TypeLeaveRoom:
		return h.handleLeaveRoom(ctx, cc, d)
	case TypeError:
		// Clients may send `error` back as informational; log + drop.
		h.Log.Debug("mesh client error reported",
			slog.String("conn_id", cc.connID),
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
		// Types reserved for later milestones (media_ready, pair_*, etc.)
		// — accept the envelope (already validated) but reply with
		// not_in_room so a malformed client cannot drive state we have
		// not built yet. M5+ replaces this default with real handlers.
		h.writeError(ctx, cc, &ProtocolError{
			Code:    CodeNotInRoom,
			Message: string(d.Envelope.Type) + " is not yet wired in this milestone",
		}, d.Envelope.RequestID)
		return nil
	}
}

// handleJoinRoom implements §3.1 + §3.2 + §3.3 + §3.4.
func (h *Handler) handleJoinRoom(ctx context.Context, cc *connCtx, d *Decoded) error {
	if cc.peerID != "" {
		h.writeError(ctx, cc, &ProtocolError{
			Code:    CodeAlreadyJoined,
			Message: "this connection has already joined a mesh room",
		}, d.Envelope.RequestID)
		return nil
	}
	roomID := d.Envelope.RoomID
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
			slog.String("conn_id", cc.connID), slog.String("error", err.Error()))
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
			slog.String("conn_id", cc.connID), slog.String("error", err.Error()))
	}

	// mesh_roster_update (§3.5) — broadcast presence:joined to ALL
	// participants in the room INCLUDING the subject.
	h.broadcastRosterUpdate(rm, outcome.Participant, PresenceJoined, RosterReasonAdmitted)

	h.Log.Info("mesh peer admitted",
		slog.String("event", "mesh_peer_admitted"),
		slog.String("conn_id", cc.connID),
		slog.String("peer_id", cc.peerID),
		slog.String("room_id", roomID),
		slog.Uint64("admission_index", outcome.Participant.AdmissionIndex),
	)
	return nil
}

// handleLeaveRoom implements §3.18.
func (h *Handler) handleLeaveRoom(ctx context.Context, cc *connCtx, d *Decoded) error {
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
	_ = cc.conn.Close(websocket.StatusNormalClosure, "graceful_leave")
	return nil
}

// releaseAndNotify is the canonical disconnect path (data-model §C.4).
// Frees the slot, broadcasts mesh_roster_update presence:left to any
// remaining participants. Idempotent via cc.released so the deferred
// ServeHTTP cleanup and an explicit leave_room don't double-emit.
func (h *Handler) releaseAndNotify(cc *connCtx, reason string, rosterReason RosterReason) {
	if cc.released.Load() || cc.peerID == "" {
		return
	}
	outcome := h.Manager.Release(cc.roomID, cc.peerID)
	cc.released.Store(true)
	if outcome.Departing == nil {
		return
	}
	// Departing presence is `released` if the participant never reached
	// media-ready, else `left`. M3 has no media yet so all departures
	// are pre-pairing — every M3 release emits `left` for graceful
	// leaves and `left` for disconnects (both are valid wire values
	// even pre-pair). M5+ will refine this with the released-vs-left
	// classification once media_ready is wired.
	presence := PresenceLeft
	if outcome.Departing.Readiness == ReadinessJoined {
		presence = PresenceLeft // still wire-valid; refined in M5
	}
	rm := outcome.Room
	rm.Lock()
	update := BuildRosterUpdate(rm, outcome.Departing, presence, rosterReason)
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

// sendJoinRejected centralizes the join_rejected send.
func (h *Handler) sendJoinRejected(ctx context.Context, cc *connCtx, roomID, requestID string, result JoinRejectedResult, reason JoinRejectedReason, message string) {
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

func classifyReadError(err error) string {
	status := websocket.CloseStatus(err)
	if status != -1 {
		return "peer_close"
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return "ctx_done"
	}
	return "read_error"
}

func formatConnID(n uint64) string {
	return "m-" + strconv.FormatUint(n, 10)
}
