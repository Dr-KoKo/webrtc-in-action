// Package mesh hosts the 002 multi-party mesh signaling endpoint
// (`/ws/mesh`). It is intentionally separate from the 001 onetoone
// package so the 001 v1 codepath stays untouched (plan §6
// preservation boundary). Cross-mode lookups are forbidden — the two
// registries share nothing.
package mesh

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"sync/atomic"

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
// pair negotiation) lives on signaling.Service — that's the
// lesson.
type Handler struct {
	Log       *slog.Logger
	Heartbeat heartbeat.Config
	Manager   *room.RoomManager

	// IceServers is the v2 RTCIceServer list relayed in
	// `join_accepted`, `pair_negotiation_instruction`, and
	// `pair_reconnect_instruction`. Set from cfg at construction;
	// never logged (TURN credentials are secrets per NFR-003).
	IceServers []protocol.IceServer

	service *signaling.Service
	server  *wsserver.Server
}

// NewHandler builds the 002 mesh handler from a fully-resolved
// ModeConfig. Env reading lives in internal/shared/config; this
// constructor takes only typed values. The heartbeat defaults
// shipped by config.Load() match 001 (5 s + 5 s) so SC-005a's ≤10 s
// detection bound is satisfied unless a caller explicitly widens it.
func NewHandler(log *slog.Logger, cfg config.ModeConfig) *Handler {
	if log == nil {
		log = slog.Default()
	}
	h := &Handler{
		Log:        log,
		Heartbeat:  cfg.Heartbeat,
		Manager:    room.NewRoomManager(),
		IceServers: iceServersFromConfig(cfg.IceServers),
	}
	h.service = signaling.NewService(log, h.Manager, h.IceServers)
	h.server = wsserver.New(h, wsserver.Config{
		Logger:             log,
		Heartbeat:          h.Heartbeat,
		HeartbeatLabels:    meshHeartbeatLabels,
		InsecureSkipVerify: cfg.WebSocket.InsecureSkipVerify,
		OriginPatterns:     cfg.WebSocket.OriginPatterns,
		ConnIDPrefix:       "m-",
		Connect:            wsserver.LogLine{Event: "mesh_ws_connected", Message: "mesh websocket connected"},
		Disconnect:         wsserver.LogLine{Event: "mesh_ws_disconnected", Message: "mesh websocket disconnected"},
		AcceptFailed:       wsserver.LogLine{Event: "mesh_ws_accept_failed", Message: "mesh websocket accept failed"},
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
	return &SessionMesh{sess: sess, service: h.service, log: log}, nil
}

// iceServersFromConfig converts the shared internal config.IceServer
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
// wsserver.SessionHandler (HandleFrame + OnDisconnect) AND
// signaling.Conn (the verb-side contract). Transport-level fields
// (the *websocket.Conn, write mutex, conn-id) live on the wrapped
// wsserver.Session.
type SessionMesh struct {
	sess     wsserver.Session
	service  *signaling.Service
	log      *slog.Logger
	peerID   string
	roomID   string
	released atomic.Bool
}

// SendJSON marshals v as a text frame and forwards to
// wsserver.Session, which serializes the write under its mutex.
func (c *SessionMesh) SendJSON(ctx context.Context, v any) error {
	raw, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return c.sess.Send(ctx, raw)
}

// HandleFrame is the wsserver-side dispatch entry point. Delegates
// the entire pipeline (decode + verb dispatch + error frame) to
// signaling.Service.HandleFrame.
func (c *SessionMesh) HandleFrame(ctx context.Context, frame []byte) error {
	return c.service.HandleFrame(ctx, c, frame)
}

// OnDisconnect runs once during teardown. The transportReason
// argument names the wire-level cause but is intentionally NOT
// forwarded to room cleanup, which uses the domain reason
// RosterReasonDisconnect for non-graceful exits (data-model §C.4).
// releaseAndNotify uses ReleaseOnce internally so a graceful
// leave_room and an ungraceful disconnect cannot both run cleanup.
func (c *SessionMesh) OnDisconnect(transportReason string) []slog.Attr {
	_ = transportReason
	c.service.ReleaseAndNotify(c, "disconnect", protocol.RosterReasonDisconnect)
	return nil
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
// instructions) thread this ctx when writing to other sessions
// whose lifetime is unrelated to the caller's request ctx.
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
// admits this connection.
func (c *SessionMesh) MarkJoined(peerID, roomID string) {
	c.peerID = peerID
	c.roomID = roomID
}

// ClearJoined wipes the joined identifiers after release.
func (c *SessionMesh) ClearJoined() {
	c.peerID = ""
	c.roomID = ""
}

// ReleaseOnce atomically transitions released from false to true.
// Returns true on the first call.
func (c *SessionMesh) ReleaseOnce() bool {
	return c.released.CompareAndSwap(false, true)
}

// ResetReleaseLatch flips released back to false so a subsequent
// disconnect on the SAME connection (e.g. after a media_failed
// retry) still triggers cleanup.
func (c *SessionMesh) ResetReleaseLatch() { c.released.Store(false) }
