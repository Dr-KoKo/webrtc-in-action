package onetoone

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"sync/atomic"

	"github.com/coder/websocket"

	"webrtc-lab/signaling/internal/modes/onetoone/protocol"
	"webrtc-lab/signaling/internal/modes/onetoone/room"
	"webrtc-lab/signaling/internal/modes/onetoone/signaling"
	"webrtc-lab/signaling/internal/shared/config"
	"webrtc-lab/signaling/internal/shared/heartbeat"
	"webrtc-lab/signaling/internal/shared/wsserver"
)

// Handler is the /ws upgrader for the 001 1:1 contract. It owns
// the room manager and ICE config; the WebSocket session lifecycle
// (Accept, conn-id, heartbeat, read loop, write mutex, error
// classification, teardown) lives in internal/shared/wsserver. Each
// session's mode-specific state lives on Session1to1 below.
//
// NewHandler returns *Handler so existing tests can mutate
// h.Heartbeat AFTER construction (heartbeat_test.go:62) — the
// wsserver Config carries &h.Heartbeat so those mutations reach
// the running server.
type Handler struct {
	Log           *slog.Logger
	Heartbeat     heartbeat.Config
	Rooms         *room.RoomManager
	AcceptOptions *websocket.AcceptOptions

	// IceServers is the RTCIceServer list relayed in `ready_for_offer`
	// (contract §3.7). Loaded once at construction from env; never
	// logged (TURN credentials are secrets). If the list is empty, a
	// public STUN fallback is used so a fresh clone works on localhost.
	IceServers []protocol.IceServer

	service *signaling.Service
	server  *wsserver.Server
}

// NewHandler returns a Handler with a fresh RoomManager and
// sensible defaults from env.
func NewHandler(log *slog.Logger) *Handler {
	if log == nil {
		log = slog.Default()
	}
	h := &Handler{
		Log:        log,
		Heartbeat:  heartbeat.LoadFromEnv(),
		Rooms:      room.NewRoomManager(),
		IceServers: iceServersFromConfig(config.LoadIceServersFromEnv()),
		AcceptOptions: &websocket.AcceptOptions{
			// Dev convenience: allow WS from any origin so the Vite
			// dev server on a different port can connect. Phase 13
			// tightens this for production.
			InsecureSkipVerify: true,
		},
	}
	h.service = signaling.NewService(log, h.Rooms, h.IceServers)
	h.server = wsserver.New(h, wsserver.Config{
		Logger:          log,
		Heartbeat:       &h.Heartbeat,
		HeartbeatLabels: oneToOneHeartbeatLabels,
		Accept:          h.AcceptOptions,
		ConnIDPrefix:    "c-",
		Connect:         wsserver.LogLine{Event: "ws_connected", Message: "websocket connected"},
		Disconnect:      wsserver.LogLine{Event: "ws_disconnected", Message: "websocket disconnected"},
		AcceptFailed:    wsserver.LogLine{Event: "ws_accept_failed", Message: "websocket accept failed"},
	})
	return h
}

// ServeHTTP delegates to the wsserver.Server built at NewHandler
// time. The transport plumbing lives there so this file opens with
// the 1:1 lesson — admission, ready-for-offer pairing, presence
// changes — instead of WebSocket bookkeeping.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.server.ServeHTTP(w, r)
}

// NewSession satisfies wsserver.Mode — one call per accepted WS.
func (h *Handler) NewSession(sess wsserver.Session, log *slog.Logger) (wsserver.SessionHandler, error) {
	return &Session1to1{sess: sess, service: h.service, log: log}, nil
}

// iceServersFromConfig converts the shared internal config.IceServer
// struct (no JSON tags) to this mode's wire-payload type with v1
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

// Session1to1 is the per-WS 001 state. Implements
// wsserver.SessionHandler (the transport contract) and
// signaling.Conn (the verb-side contract). Transport-level fields
// (the *websocket.Conn, write mutex, conn-id) live on the wrapped
// wsserver.Session; this struct keeps only the 001 protocol state.
type Session1to1 struct {
	sess     wsserver.Session
	service  *signaling.Service
	log      *slog.Logger
	peerID   string
	roomID   string
	released atomic.Bool // flipped true once the slot has been released
}

// SendJSON marshals v as a text frame and forwards to
// wsserver.Session, which serializes the write under its mutex.
func (c *Session1to1) SendJSON(ctx context.Context, v any) error {
	raw, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return c.sess.Send(ctx, raw)
}

// HandleFrame is the wsserver-side dispatch entry point. Delegates
// the entire pipeline (decode + verb dispatch + error frame) to
// signaling.Service.HandleFrame.
func (c *Session1to1) HandleFrame(ctx context.Context, frame []byte) error {
	return c.service.HandleFrame(ctx, c, frame)
}

// OnDisconnect runs once during teardown. The transportReason
// argument names the wire-level cause (peer_close / read_error /
// etc.) but is intentionally NOT forwarded into the room cleanup,
// which uses the domain reason "disconnect" for non-graceful
// exits — preserving the semantics of pre-refactor handler.go:172
// where releaseAndNotify was always called with reason="disconnect"
// regardless of how the read loop terminated. Returns the optional
// `peer_id` slog.Attr that gets merged into the disconnect log
// line for admitted connections.
//
// Uses ReleaseOnce so the cleanup runs at most once even if a
// graceful leave_room and a disconnect race; the read-goroutine
// ordering already prevents this in practice, but the CAS makes
// it airtight.
func (c *Session1to1) OnDisconnect(transportReason string) []slog.Attr {
	_ = transportReason
	if c.peerID != "" && c.ReleaseOnce() {
		c.service.ReleaseAndNotify(c, "disconnect")
	}
	if c.peerID != "" {
		return []slog.Attr{slog.String("peer_id", c.peerID)}
	}
	return nil
}

// ID returns the per-WS connection identifier assigned by wsserver.
func (c *Session1to1) ID() string { return c.sess.ID() }

// CloseNormal sends a normal-closure frame with the given reason.
// Hides coder/websocket.StatusCode from the signaling layer.
func (c *Session1to1) CloseNormal(reason string) error {
	return c.sess.Close(websocket.StatusNormalClosure, reason)
}

// BaseContext returns the per-session base context (cancelled at
// teardown). Async fan-outs (presence, peer_left) thread this ctx
// when writing to other sessions whose lifetime is unrelated to
// the caller's request ctx.
func (c *Session1to1) BaseContext() context.Context { return c.sess.BaseContext() }

// State returns a snapshot of the per-conn join/release state.
// Returned by value so the caller cannot mutate the session
// indirectly.
func (c *Session1to1) State() signaling.ConnState {
	return signaling.ConnState{
		PeerID:   c.peerID,
		RoomID:   c.roomID,
		Released: c.released.Load(),
	}
}

// MarkJoined records the peerID/roomID pair after the room manager
// admits this connection. Called once per successful admission
// before any verb fires.
func (c *Session1to1) MarkJoined(peerID, roomID string) {
	c.peerID = peerID
	c.roomID = roomID
}

// ClearJoined wipes the joined identifiers after release. Must
// only be called after a successful ReleaseOnce; the ordering is
// codified in specs/signaling-architecture.md §3.4.
func (c *Session1to1) ClearJoined() {
	c.peerID = ""
	c.roomID = ""
}

// ReleaseOnce atomically transitions released from false to true.
// Returns true on the first call (the caller has claimed cleanup
// duty), false thereafter. Replaces the pre-refactor pattern of
// `if !released.Load() { releaseAndNotify; released.Store(true) }`
// with a TOCTOU-free single CAS.
func (c *Session1to1) ReleaseOnce() bool {
	return c.released.CompareAndSwap(false, true)
}

// ResetReleaseLatch flips released back to false so a subsequent
// disconnect on the SAME connection (e.g. after a media_failed
// retry) still triggers cleanup. The only valid call site is the
// media_failed retry path; calling it elsewhere re-arms a latch
// that does not need re-arming.
func (c *Session1to1) ResetReleaseLatch() { c.released.Store(false) }
