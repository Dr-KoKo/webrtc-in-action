package onetoone

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"

	"webrtc-lab/signaling/internal/modes/onetoone/protocol"
	"webrtc-lab/signaling/internal/modes/onetoone/room"
	"webrtc-lab/signaling/internal/shared/config"
	"webrtc-lab/signaling/internal/shared/heartbeat"
	"webrtc-lab/signaling/internal/shared/wsserver"
)

// Handler is the /ws upgrader for the 001 1:1 contract. It owns
// the room manager and ICE config; the WebSocket session lifecycle
// (Accept, conn-id, heartbeat, read loop, write mutex, error
// classification, teardown) lives in internal/shared/wsserver. Each
// session's mode-specific state lives on oneToOneConn below.
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

	server *wsserver.Server
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
	return &oneToOneConn{sess: sess, handler: h, log: log}, nil
}

// iceServersFromConfig converts the shared internal protocol.IceServer
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

// oneToOneConn is the per-WS 001 state. Implements
// wsserver.SessionHandler. Transport-level fields (the
// *websocket.Conn, write mutex, conn-id) live on the wrapped
// wsserver.Session; this struct keeps only the 001 protocol state.
type oneToOneConn struct {
	sess     wsserver.Session
	handler  *Handler
	log      *slog.Logger
	peerID   string
	roomID   string
	released atomic.Bool // flipped true once the slot has been released
}

// sendJSON marshals v as a text frame and forwards to
// wsserver.Session, which serializes the write under its mutex.
func (c *oneToOneConn) sendJSON(ctx context.Context, v any) error {
	raw, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return c.sess.Send(ctx, raw)
}

// HandleFrame is the wsserver-side dispatch entry point. Decodes
// the envelope; on decode failure writes a typed `error` frame
// back, logs the mode-specific `code` field, and returns nil so
// the read loop continues. Dispatch errors are already surfaced
// to the client via writeError inside the per-type handlers; we
// log and return nil for the same continue-on-non-fatal reason.
func (c *oneToOneConn) HandleFrame(ctx context.Context, frame []byte) error {
	decoded, derr := protocol.Decode(frame)
	if derr != nil {
		var de *protocol.DecodeError
		errors.As(derr, &de)
		c.handler.writeError(ctx, c, de, "")
		c.handler.Log.Debug("decode error",
			slog.String("conn_id", c.sess.ID()),
			slog.String("code", string(de.Code)),
		)
		return nil
	}
	if err := c.handler.dispatch(ctx, c, decoded); err != nil {
		c.handler.Log.Debug("dispatch error",
			slog.String("conn_id", c.sess.ID()),
			slog.String("type", string(decoded.Envelope.Type)),
			slog.String("error", err.Error()),
		)
	}
	return nil
}

// OnDisconnect runs once during teardown. The transportReason
// argument names the wire-level cause (peer_close / read_error /
// etc.) but is intentionally NOT forwarded into the room cleanup,
// which uses the domain reason "disconnect" for non-graceful
// exits — preserving the semantics of pre-refactor handler.go:172
// where releaseAndNotify was always called with reason="disconnect"
// regardless of how the read loop terminated. Returns the optional
// `peer_id` slog.Attr that gets merged into the disconnect log
// line for admitted connections (matches pre-refactor lines
// 182-184).
func (c *oneToOneConn) OnDisconnect(transportReason string) []slog.Attr {
	_ = transportReason
	if c.peerID != "" && !c.released.Load() {
		c.handler.releaseAndNotify(context.Background(), c, "disconnect")
	}
	if c.peerID != "" {
		return []slog.Attr{slog.String("peer_id", c.peerID)}
	}
	return nil
}

// roomConn adapts a *oneToOneConn to the room.Conn interface used
// by the room package to send messages to a participant. The
// per-session base context (cancelled at teardown) is read from
// the wrapped wsserver.Session at send time — replaces the
// pre-refactor baseCtx field captured at admission.
type roomConn struct {
	c *oneToOneConn
}

func (r *roomConn) SendJSON(v any) error {
	return r.c.sendJSON(r.c.sess.BaseContext(), v)
}

// dispatch routes a decoded envelope to the correct handler for the
// current phase. Types not yet wired are rejected with an `error`
// frame so a malformed client cannot drive state we have not built.
func (h *Handler) dispatch(ctx context.Context, cc *oneToOneConn, d *protocol.Decoded) error {
	switch d.Envelope.Type {
	case protocol.TypeJoinRoom:
		return h.handleJoinRoom(ctx, cc, d)
	case protocol.TypeLeaveRoom:
		return h.handleLeaveRoom(ctx, cc, d)
	case protocol.TypeMediaReady:
		return h.handleMediaReady(ctx, cc, d)
	case protocol.TypeMediaFailed:
		return h.handleMediaFailed(ctx, cc, d)
	case protocol.TypeOffer:
		return h.handleOffer(ctx, cc, d)
	case protocol.TypeAnswer:
		return h.handleAnswer(ctx, cc, d)
	case protocol.TypeIceCandidate:
		return h.handleIceCandidate(ctx, cc, d)
	case protocol.TypeMediaState:
		return h.handleMediaState(ctx, cc, d)
	case protocol.TypeReadyForOffer, protocol.TypeJoinAccepted, protocol.TypeJoinRejected,
		protocol.TypePeerPresenceChanged, protocol.TypePeerLeft, protocol.TypeParticipantReleased:
		// These are server-originated; a client sending them is a bug.
		h.writeError(ctx, cc, &protocol.DecodeError{
			Code:    protocol.CodeMalformed,
			Message: "server-originated message received from client",
		}, d.Envelope.RequestID)
		return nil
	case protocol.TypeError:
		// Clients may send `error` back to flag inbound-validation
		// failures. Log and drop — the server treats these as
		// informational.
		h.Log.Debug("client-reported error",
			slog.String("conn_id", cc.sess.ID()),
		)
		return nil
	}
	return nil
}

func (h *Handler) handleJoinRoom(ctx context.Context, cc *oneToOneConn, d *protocol.Decoded) error {
	if cc.peerID != "" {
		h.writeError(ctx, cc, &protocol.DecodeError{
			Code:    protocol.CodeAlreadyJoined,
			Message: "this connection has already joined a room",
		}, d.Envelope.RequestID)
		return nil
	}

	roomID := d.Envelope.RoomID
	if err := protocol.ValidateRoomID(roomID); err != nil {
		// Contract §3.1 + §3.3 route invalid IDs to join_rejected, not
		// the generic `error` message, because it is a terminal
		// admission outcome not a protocol violation.
		h.sendJoinRejected(ctx, cc, roomID, d.Envelope.RequestID,
			protocol.JoinRejectedInvalidRoom, protocol.ReasonInvalidRoomID,
			"room ID must match ^[A-Za-z0-9._-]{1,64}$.")
		return nil
	}

	outcome := h.Rooms.Admit(roomID, &roomConn{c: cc})

	switch outcome.Result {
	case room.JoinRejectedInvalidRoom:
		h.sendJoinRejected(ctx, cc, roomID, d.Envelope.RequestID,
			protocol.JoinRejectedInvalidRoom, protocol.ReasonInvalidRoomID,
			"room ID must match ^[A-Za-z0-9._-]{1,64}$.")
		return nil

	case room.JoinRejectedRoomFull:
		h.sendJoinRejected(ctx, cc, roomID, d.Envelope.RequestID,
			protocol.JoinRejectedRoomFull, protocol.ReasonRoomFull,
			"Room '"+roomID+"' already has two reserved participants.")
		return nil

	case room.JoinAccepted:
		cc.peerID = outcome.Participant.PeerID
		cc.roomID = outcome.Participant.RoomID
	}

	// Snapshot the remote peer (if any) under the room lock so the
	// join_accepted payload reflects the state at admission time.
	outcome.Room.Lock()
	var remote *protocol.RemotePeerSnapshot
	if r := outcome.Room.Remote(outcome.Participant.PeerID); r != nil {
		remote = &protocol.RemotePeerSnapshot{
			PeerID:         r.PeerID,
			MediaReadiness: toWireMediaReadiness(r.MediaReadiness),
		}
	}
	readiness := toWireRoomReadiness(outcome.Room.CallReadiness())
	admissionOrder := outcome.Participant.AdmissionOrder
	outcome.Room.Unlock()

	payload, _ := json.Marshal(protocol.JoinAcceptedPayload{
		PeerID:         outcome.Participant.PeerID,
		AdmissionOrder: admissionOrder,
		RoomReadiness:  readiness,
		RemotePeer:     remote,
	})
	env := protocol.Envelope{
		V:         protocol.ContractVersion,
		Type:      protocol.TypeJoinAccepted,
		RoomID:    roomID,
		RequestID: d.Envelope.RequestID,
		TS:        time.Now().UnixMilli(),
		Payload:   payload,
	}
	if err := cc.sendJSON(ctx, env); err != nil {
		h.Log.Warn("join_accepted send failed",
			slog.String("conn_id", cc.sess.ID()), slog.String("error", err.Error()))
	}

	// Broadcast the admission event to both reserved participants (§3.4,
	// §T025 DoD — including the subject).
	h.broadcastPresence(ctx, outcome.Room, outcome.Participant,
		protocol.PresencePendingMedia, protocol.PresenceReasonAdmitted)

	h.Log.Info("peer admitted",
		slog.String("event", "peer_admitted"),
		slog.String("conn_id", cc.sess.ID()),
		slog.String("peer_id", cc.peerID),
		slog.String("room_id", cc.roomID),
		slog.Int("admission_order", admissionOrder),
	)
	return nil
}

func (h *Handler) handleLeaveRoom(ctx context.Context, cc *oneToOneConn, d *protocol.Decoded) error {
	if cc.peerID == "" {
		h.writeError(ctx, cc, &protocol.DecodeError{
			Code:    protocol.CodeNotInRoom,
			Message: "leave_room requires an admitted participant",
		}, d.Envelope.RequestID)
		return nil
	}

	h.releaseAndNotify(ctx, cc, "graceful_leave")

	// Contract §3.14 step 5: close the sender's WS. Clearing the
	// cc identifiers is defense-in-depth — the read loop exits on
	// the next Read anyway once the close frame is sent, and the
	// deferred ServeHTTP cleanup already guards against
	// double-release via cc.released.
	cc.peerID = ""
	cc.roomID = ""
	_ = cc.sess.Close(websocket.StatusNormalClosure, "graceful_leave")
	return nil
}

// departureClassification captures the §C.6 step-1 decision: was the
// departing peer in-call (role-assigned | negotiating | connected)
// or still pre-pairing (pending-media, or ready-but-not-paired). The
// same classification decides both the presence enum on the broadcast
// and whether the convenience peer_left message is sent.
type departureClassification struct {
	inCall         bool
	presence       protocol.Presence
	presenceReason protocol.PresenceReason
	peerLeftReason protocol.PeerLeftReason
}

// classifyDeparture runs §C.6 step 1 BEFORE any state mutation. The
// caller passes `reason ∈ {"graceful_leave", "disconnect",
// "media_failed"}` — reason drives the protocol.PresenceReason / protocol.PeerLeftReason
// labels but never overrides the in-call / pre-pairing split. A
// pending-media departure is ALWAYS pre-pairing regardless of reason,
// which is the invariant T086's
// `TestPendingMediaDisconnectDoesNotEmitPeerLeft` locks down.
func classifyDeparture(p *room.Participant, reason string) departureClassification {
	inCall := false
	if p != nil {
		inCall = room.IsInCall(p.CallPhase)
	}
	var presence protocol.Presence
	if inCall {
		presence = protocol.PresenceLeft
	} else {
		presence = protocol.PresenceReleased
	}
	var presReason protocol.PresenceReason
	switch reason {
	case "graceful_leave":
		presReason = protocol.PresenceReasonGracefulLeave
	case "disconnect":
		presReason = protocol.PresenceReasonDisconnect
	case "media_failed":
		presReason = protocol.PresenceReasonMediaFailed
	default:
		presReason = protocol.PresenceReasonDisconnect
	}
	var peerLeftReason protocol.PeerLeftReason
	if reason == "graceful_leave" {
		peerLeftReason = protocol.PeerLeftGracefulLeave
	} else {
		peerLeftReason = protocol.PeerLeftDisconnect
	}
	return departureClassification{
		inCall:         inCall,
		presence:       presence,
		presenceReason: presReason,
		peerLeftReason: peerLeftReason,
	}
}

// releaseAndNotify runs the canonical server-side cleanup sequence
// from data-model §C.6 for a single departing participant. reason is
// "graceful_leave" (leave_room), "disconnect" (WS close / heartbeat
// pong timeout — see heartbeat.go), or "media_failed" (post-admission
// media acquisition failure).
//
// Classification happens BEFORE the slot is mutated so the
// in-call-vs-pre-pairing decision is based on the participant's
// CallPhase at the moment of departure. Pending-media releases
// (media_failed, pending-media disconnect) are ALWAYS classified as
// pre-pairing and MUST NOT emit peer_left, even in Phase 4+.
//
// Pong timeout routes through this same function: runHeartbeat
// returns a HeartbeatError on timeout → the read loop unblocks with
// an error → the deferred ServeHTTP cleanup calls
// releaseAndNotify(_, cc, "disconnect"). Classification + emit logic
// is therefore shared across graceful leave_room, WS-close, and
// heartbeat-timeout paths — one source of truth.
func (h *Handler) releaseAndNotify(_ context.Context, cc *oneToOneConn, reason string) {
	roomID := cc.roomID
	peerID := cc.peerID

	// Snapshot the departing participant's state under the room lock
	// so classification is consistent with the release.
	rm := h.Rooms.Room(roomID)
	if rm == nil {
		cc.released.Store(true)
		return
	}

	rm.Lock()
	p := rm.FindByPeerID(peerID)
	cls := classifyDeparture(p, reason)
	rm.Unlock()

	outcome := h.Rooms.Release(roomID, peerID)
	cc.released.Store(true)

	if outcome.Departing == nil {
		// Either the slot was already gone (double-release race) or
		// the connection never successfully joined.
		return
	}

	if outcome.Remaining == nil {
		// No one to notify.
		return
	}

	// peer_presence_changed is ALWAYS sent on departure (§C.6 step 4).
	presencePayload, _ := json.Marshal(protocol.PeerPresenceChangedPayload{
		SubjectPeerID:  outcome.Departing.PeerID,
		AdmissionOrder: outcome.Departing.AdmissionOrder,
		Presence:       cls.presence,
		Reason:         cls.presenceReason,
	})
	presenceEnv := protocol.Envelope{
		V:       protocol.ContractVersion,
		Type:    protocol.TypePeerPresenceChanged,
		RoomID:  roomID,
		TS:      time.Now().UnixMilli(),
		Payload: presencePayload,
	}
	if err := outcome.Remaining.Conn.SendJSON(presenceEnv); err != nil {
		h.Log.Warn("peer_presence_changed send failed",
			slog.String("peer_id", outcome.Remaining.PeerID),
			slog.String("error", err.Error()))
	}

	// peer_left is ONLY sent for in-call departures (§C.6 step 5).
	// Pending-media releases use peer_presence_changed alone (§3.12
	// note: "Pending-media releases MUST NOT emit peer_left").
	if cls.inCall {
		payload, _ := json.Marshal(protocol.PeerLeftPayload{
			PeerID: outcome.Departing.PeerID,
			Reason: cls.peerLeftReason,
		})
		env := protocol.Envelope{
			V:       protocol.ContractVersion,
			Type:    protocol.TypePeerLeft,
			RoomID:  roomID,
			TS:      time.Now().UnixMilli(),
			Payload: payload,
		}
		if err := outcome.Remaining.Conn.SendJSON(env); err != nil {
			h.Log.Warn("peer_left send failed",
				slog.String("peer_id", outcome.Remaining.PeerID),
				slog.String("error", err.Error()))
		}
	}

	h.Log.Info("peer departed",
		slog.String("event", "peer_departed"),
		slog.String("peer_id", peerID),
		slog.String("room_id", roomID),
		slog.String("reason", reason),
		slog.Bool("in_call", cls.inCall),
		slog.Bool("room_gc", outcome.RoomGarbageCollected),
	)
}

// broadcastPresence sends peer_presence_changed to every reserved
// slot in the room (contract §3.4 "S→B to both reserved
// participants, including the subject").
func (h *Handler) broadcastPresence(_ context.Context, r *room.Room, subject *room.Participant, presence protocol.Presence, reason protocol.PresenceReason) {
	r.Lock()
	targets := r.Participants()
	r.Unlock()

	payload, _ := json.Marshal(protocol.PeerPresenceChangedPayload{
		SubjectPeerID:  subject.PeerID,
		AdmissionOrder: subject.AdmissionOrder,
		Presence:       presence,
		Reason:         reason,
	})
	env := protocol.Envelope{
		V:       protocol.ContractVersion,
		Type:    protocol.TypePeerPresenceChanged,
		RoomID:  subject.RoomID,
		TS:      time.Now().UnixMilli(),
		Payload: payload,
	}

	for _, p := range targets {
		if p.Conn == nil {
			continue
		}
		if err := p.Conn.SendJSON(env); err != nil {
			h.Log.Warn("peer_presence_changed send failed",
				slog.String("peer_id", p.PeerID),
				slog.String("error", err.Error()))
		}
	}
}

// sendJoinRejected centralizes the join_rejected send so both the
// pre-admit room-ID validator and the RoomManager rejection paths use
// the same envelope shape.
func (h *Handler) sendJoinRejected(ctx context.Context, cc *oneToOneConn, roomID, requestID string, result protocol.JoinRejectedResult, reason protocol.JoinRejectedReason, message string) {
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
	_ = cc.sendJSON(ctx, env)
}

func (h *Handler) writeError(ctx context.Context, cc *oneToOneConn, de *protocol.DecodeError, correlates string) {
	payload, _ := json.Marshal(protocol.ErrorPayload{
		Code:       de.Code,
		Message:    de.Message,
		Correlates: correlates,
	})
	env := protocol.Envelope{
		V:       protocol.ContractVersion,
		Type:    protocol.TypeError,
		TS:      time.Now().UnixMilli(),
		Payload: payload,
	}
	_ = cc.sendJSON(ctx, env)
}

// ---------------------------------------------------------------------
// room → wire enum mapping
// ---------------------------------------------------------------------

func toWireMediaReadiness(m room.MediaReadiness) protocol.MediaReadiness {
	switch m {
	case room.MediaReadinessReady:
		return protocol.MediaReady
	}
	return protocol.MediaPending
}

func toWireRoomReadiness(c room.CallReadiness) protocol.RoomReadiness {
	switch c {
	case room.CallReadinessEmpty:
		return protocol.RoomEmpty
	case room.CallReadinessWaitingForMedia:
		return protocol.RoomWaitingForMedia
	case room.CallReadinessWaitingForPeer:
		return protocol.RoomWaitingForPeer
	case room.CallReadinessPaired:
		return protocol.RoomPaired
	}
	return protocol.RoomEmpty
}

// ---------------------------------------------------------------------
// Phase 4 — media-ready pairing + role assignment
// ---------------------------------------------------------------------

// handleMediaReady transitions the sender's mediaReadiness
// pending-media → ready, broadcasts peer_presence_changed(ready,
// media_ready), and — if the room reaches paired call-readiness —
// assigns roles by admissionOrder and emits ready_for_offer to both
// peers exactly once per pairing attempt (contract §§3.5, 3.7).
func (h *Handler) handleMediaReady(ctx context.Context, cc *oneToOneConn, d *protocol.Decoded) error {
	if cc.peerID == "" {
		h.writeError(ctx, cc, &protocol.DecodeError{
			Code:    protocol.CodeNotInRoom,
			Message: "media_ready requires an admitted participant",
		}, d.Envelope.RequestID)
		return nil
	}
	rm := h.Rooms.Room(cc.roomID)
	if rm == nil {
		h.writeError(ctx, cc, &protocol.DecodeError{
			Code:    protocol.CodeNotInRoom,
			Message: "room not found",
		}, d.Envelope.RequestID)
		return nil
	}

	rm.Lock()
	p := rm.FindByPeerID(cc.peerID)
	if p == nil {
		rm.Unlock()
		h.writeError(ctx, cc, &protocol.DecodeError{
			Code:    protocol.CodeNotInRoom,
			Message: "participant not found",
		}, d.Envelope.RequestID)
		return nil
	}
	if p.MediaReadiness != room.MediaReadinessPending {
		rm.Unlock()
		h.writeError(ctx, cc, &protocol.DecodeError{
			Code:    protocol.CodeUnexpectedMediaReady,
			Message: "media_ready requires mediaReadiness = pending-media",
		}, d.Envelope.RequestID)
		return nil
	}

	p.MediaReadiness = room.MediaReadinessReady

	// Capture everything we need for post-unlock work.
	assignRoles := rm.CallReadiness() == room.CallReadinessPaired && !rm.RolesAssigned()
	var pairParticipants []*room.Participant
	if assignRoles {
		pairParticipants = rm.Participants()
		for _, pp := range pairParticipants {
			pp.CallPhase = room.CallPhaseRoleAssigned
		}
		rm.SetRolesAssigned(true)
	}
	rm.Unlock()

	h.broadcastPresence(ctx, rm, p, protocol.PresenceReady, protocol.PresenceReasonMediaReady)

	if assignRoles {
		h.sendReadyForOffer(ctx, rm, pairParticipants)
	}

	h.Log.Info("media ready",
		slog.String("event", "media_ready"),
		slog.String("conn_id", cc.sess.ID()),
		slog.String("peer_id", cc.peerID),
		slog.String("room_id", cc.roomID),
		slog.Bool("roles_assigned", assignRoles),
	)
	return nil
}

// handleMediaFailed releases the sender's slot, notifies the sender
// with `participant_released`, notifies any remaining peer via
// `peer_presence_changed(released, media_failed)`, and clears the
// connCtx's room / peer association so the same WebSocket MAY send
// another `join_room` (contract §§3.6, 3.13 "Server-side retry
// support"). No `peer_left` is emitted — pending-media releases are
// pre-pairing by definition.
func (h *Handler) handleMediaFailed(ctx context.Context, cc *oneToOneConn, d *protocol.Decoded) error {
	if cc.peerID == "" {
		h.writeError(ctx, cc, &protocol.DecodeError{
			Code:    protocol.CodeNotInRoom,
			Message: "media_failed requires an admitted participant",
		}, d.Envelope.RequestID)
		return nil
	}
	payload, _ := d.Message.(*protocol.MediaFailedPayload)

	rm := h.Rooms.Room(cc.roomID)
	if rm == nil {
		h.writeError(ctx, cc, &protocol.DecodeError{
			Code:    protocol.CodeNotInRoom,
			Message: "room not found",
		}, d.Envelope.RequestID)
		return nil
	}

	rm.Lock()
	p := rm.FindByPeerID(cc.peerID)
	if p == nil {
		rm.Unlock()
		h.writeError(ctx, cc, &protocol.DecodeError{
			Code:    protocol.CodeNotInRoom,
			Message: "participant not found",
		}, d.Envelope.RequestID)
		return nil
	}
	if p.MediaReadiness != room.MediaReadinessPending {
		rm.Unlock()
		h.writeError(ctx, cc, &protocol.DecodeError{
			Code:    protocol.CodeMalformed,
			Message: "media_failed requires mediaReadiness = pending-media",
		}, d.Envelope.RequestID)
		return nil
	}
	rm.Unlock()

	// Send participant_released to the failed peer BEFORE releasing —
	// the WS is still open and reachable.
	detail := ""
	if payload != nil {
		detail = string(payload.Reason)
	}
	relPayload, _ := json.Marshal(protocol.ParticipantReleasedPayload{
		Result: protocol.ParticipantReleasedMediaFailed,
		Reason: protocol.ReleasedReasonMediaFailed,
		Detail: detail,
	})
	relEnv := protocol.Envelope{
		V:       protocol.ContractVersion,
		Type:    protocol.TypeParticipantReleased,
		RoomID:  cc.roomID,
		TS:      time.Now().UnixMilli(),
		Payload: relPayload,
	}
	if err := cc.sendJSON(ctx, relEnv); err != nil {
		h.Log.Warn("participant_released send failed",
			slog.String("conn_id", cc.sess.ID()),
			slog.String("error", err.Error()))
	}

	// Release the slot and notify any remaining peer. The in-call
	// classification inside releaseAndNotify will correctly pick
	// presence=released (pending-media implies !inCall).
	h.releaseAndNotify(ctx, cc, "media_failed")

	// Clear association so the SAME WS can send join_room again
	// without hitting already_joined. ServeHTTP's deferred cleanup now
	// short-circuits on cc.peerID == "" and will not double-release.
	// Reset cc.released so a future rejoin's disconnect still triggers
	// the cleanup path for the NEW slot.
	cc.peerID = ""
	cc.roomID = ""
	cc.released.Store(false)

	h.Log.Info("media failed",
		slog.String("event", "media_failed"),
		slog.String("conn_id", cc.sess.ID()),
		slog.String("reason", detail),
	)
	return nil
}

// sendReadyForOffer emits exactly one ready_for_offer per peer in the
// supplied pairing, using the lower `admissionOrder` as offerer
// (contract §§3.7, §C.1). Callers MUST have already flipped
// rm.SetRolesAssigned(true) and advanced both participants'
// CallPhase to role-assigned under the room lock.
func (h *Handler) sendReadyForOffer(_ context.Context, rm *room.Room, participants []*room.Participant) {
	if len(participants) != room.MaxParticipants {
		return
	}
	offerer, answerer := participants[0], participants[1]
	if answerer.AdmissionOrder < offerer.AdmissionOrder {
		offerer, answerer = answerer, offerer
	}

	send := func(self, remote *room.Participant, role protocol.Role) {
		payload, _ := json.Marshal(protocol.ReadyForOfferPayload{
			Role: role,
			RemotePeer: protocol.ReadyForOfferRemote{
				PeerID:         remote.PeerID,
				AdmissionOrder: remote.AdmissionOrder,
			},
			IceServers: h.IceServers,
		})
		env := protocol.Envelope{
			V:       protocol.ContractVersion,
			Type:    protocol.TypeReadyForOffer,
			RoomID:  rm.ID(),
			To:      self.PeerID,
			TS:      time.Now().UnixMilli(),
			Payload: payload,
		}
		if self.Conn == nil {
			return
		}
		if err := self.Conn.SendJSON(env); err != nil {
			h.Log.Warn("ready_for_offer send failed",
				slog.String("peer_id", self.PeerID),
				slog.String("error", err.Error()))
		}
	}

	send(offerer, answerer, protocol.RoleOfferer)
	send(answerer, offerer, protocol.RoleAnswerer)

	// Structured log — role + admissionOrder only; MUST NOT log
	// iceServers (TURN credential confidentiality per §3.7).
	h.Log.Info("ready_for_offer sent",
		slog.String("event", "ready_for_offer"),
		slog.String("room_id", rm.ID()),
		slog.String("offerer_peer_id", offerer.PeerID),
		slog.String("answerer_peer_id", answerer.PeerID),
	)
}

// ---------------------------------------------------------------------
// Phase 4 — offer / answer relay (T034B)
// ---------------------------------------------------------------------

// handleOffer validates an offer against the sender's assigned role
// and state (mediaReadiness × callPhase), relays it to the remote
// peer with envelope.from = sender peerId, and advances the sender's
// CallPhase role-assigned → negotiating (§§3.8, C.2).
func (h *Handler) handleOffer(ctx context.Context, cc *oneToOneConn, d *protocol.Decoded) error {
	return h.handleSDPRelay(ctx, cc, d, protocol.TypeOffer)
}

// handleAnswer mirrors handleOffer for §3.9.
func (h *Handler) handleAnswer(ctx context.Context, cc *oneToOneConn, d *protocol.Decoded) error {
	return h.handleSDPRelay(ctx, cc, d, protocol.TypeAnswer)
}

// handleSDPRelay is the shared offer / answer pathway. Keeps the
// three-field truth table (role × mediaReadiness × callPhase)
// centralized behind room.CanSendOffer / CanSendAnswer so offer and
// answer cannot drift apart.
//
// Importantly, the server NEVER parses payload.sdp.sdp — the inbound
// payload bytes are forwarded verbatim on the new envelope with only
// envelope.from / envelope.to / envelope.ts overwritten. NFR-003.
func (h *Handler) handleSDPRelay(ctx context.Context, cc *oneToOneConn, d *protocol.Decoded, t protocol.Type) error {
	if cc.peerID == "" {
		h.writeError(ctx, cc, &protocol.DecodeError{
			Code:    protocol.CodeNotInRoom,
			Message: string(t) + " requires an admitted participant",
		}, d.Envelope.RequestID)
		return nil
	}
	rm := h.Rooms.Room(cc.roomID)
	if rm == nil {
		h.writeError(ctx, cc, &protocol.DecodeError{
			Code:    protocol.CodeNotInRoom,
			Message: "room not found",
		}, d.Envelope.RequestID)
		return nil
	}

	rm.Lock()
	p := rm.FindByPeerID(cc.peerID)
	if p == nil {
		rm.Unlock()
		h.writeError(ctx, cc, &protocol.DecodeError{
			Code:    protocol.CodeNotInRoom,
			Message: "participant not found",
		}, d.Envelope.RequestID)
		return nil
	}

	role := rm.AssignedRole(cc.peerID)
	var relayErr *room.RelayError
	switch t {
	case protocol.TypeOffer:
		relayErr = p.CanSendOffer(role)
	case protocol.TypeAnswer:
		relayErr = p.CanSendAnswer(role)
	}
	if relayErr != nil {
		rm.Unlock()
		h.writeError(ctx, cc, &protocol.DecodeError{
			Code:    protocol.ErrorCode(relayErr.Code),
			Message: relayErr.Message,
		}, d.Envelope.RequestID)
		return nil
	}

	remote := rm.ResolveRemote(cc.peerID)
	if remote == nil {
		rm.Unlock()
		// Contract: remote-peer unresolvable is a transient protocol
		// failure — the remote may have just disconnected. Surface as
		// not_in_room to the sender.
		h.writeError(ctx, cc, &protocol.DecodeError{
			Code:    protocol.CodeNotInRoom,
			Message: "remote peer not present",
		}, d.Envelope.RequestID)
		return nil
	}

	// Advance sender's CallPhase through role-assigned → negotiating
	// on the first accepted offer / answer for this pairing (§3.8,
	// §3.9). Subsequent relays are no-ops at the phase layer (the
	// duplicate-offer guard lives in CanSendOffer).
	if p.CallPhase == room.CallPhaseRoleAssigned {
		p.CallPhase = room.CallPhaseNegotiating
	}

	remoteConn := remote.Conn
	remotePeerID := remote.PeerID
	rm.Unlock()

	// Relay payload bytes verbatim. Only envelope metadata is
	// rewritten — per NFR-003 the server does not parse SDP content.
	outEnv := protocol.Envelope{
		V:       protocol.ContractVersion,
		Type:    t,
		RoomID:  cc.roomID,
		From:    cc.peerID,
		To:      remotePeerID,
		TS:      time.Now().UnixMilli(),
		Payload: d.Envelope.Payload,
	}
	if remoteConn == nil {
		h.writeError(ctx, cc, &protocol.DecodeError{
			Code:    protocol.CodeNotInRoom,
			Message: "remote peer not present",
		}, d.Envelope.RequestID)
		return nil
	}
	if err := remoteConn.SendJSON(outEnv); err != nil {
		// Write failed — structured observability must NOT claim
		// success. We surface the failure to the sender as
		// `internal_error` (the best generic code for "your message
		// could not be delivered to the remote peer"), log the
		// failure, and stop without emitting the success line.
		h.Log.Warn("sdp relay failed",
			slog.String("type", string(t)),
			slog.String("peer_id", remotePeerID),
			slog.String("error", err.Error()))
		h.writeError(ctx, cc, &protocol.DecodeError{
			Code:    protocol.CodeInternalError,
			Message: "remote peer unreachable",
		}, d.Envelope.RequestID)
		return nil
	}

	h.Log.Info("sdp relayed",
		slog.String("event", "sdp_relay"),
		slog.String("type", string(t)),
		slog.String("from_peer_id", cc.peerID),
		slog.String("to_peer_id", remotePeerID),
	)
	return nil
}

// ---------------------------------------------------------------------
// Phase 8 — ice_candidate relay (T063A)
// ---------------------------------------------------------------------

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
func (h *Handler) handleIceCandidate(ctx context.Context, cc *oneToOneConn, d *protocol.Decoded) error {
	if cc.peerID == "" {
		h.writeError(ctx, cc, &protocol.DecodeError{
			Code:    protocol.CodeNotInRoom,
			Message: "ice_candidate requires an admitted participant",
		}, d.Envelope.RequestID)
		return nil
	}
	rm := h.Rooms.Room(cc.roomID)
	if rm == nil {
		h.writeError(ctx, cc, &protocol.DecodeError{
			Code:    protocol.CodeNotInRoom,
			Message: "room not found",
		}, d.Envelope.RequestID)
		return nil
	}

	rm.Lock()
	p := rm.FindByPeerID(cc.peerID)
	if p == nil {
		rm.Unlock()
		h.writeError(ctx, cc, &protocol.DecodeError{
			Code:    protocol.CodeNotInRoom,
			Message: "participant not found",
		}, d.Envelope.RequestID)
		return nil
	}
	// §3.10 truth table: either peer may send trickle candidates while
	// media-ready and in role-assigned / negotiating / connected.
	role := rm.AssignedRole(cc.peerID)
	if relayErr := p.CanSendIceCandidate(role); relayErr != nil {
		rm.Unlock()
		h.writeError(ctx, cc, &protocol.DecodeError{
			Code:    protocol.ErrorCode(relayErr.Code),
			Message: relayErr.Message,
		}, d.Envelope.RequestID)
		return nil
	}
	remote := rm.ResolveRemote(cc.peerID)
	if remote == nil {
		rm.Unlock()
		h.writeError(ctx, cc, &protocol.DecodeError{
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
		RoomID:  cc.roomID,
		From:    cc.peerID,
		To:      remotePeerID,
		TS:      time.Now().UnixMilli(),
		Payload: d.Envelope.Payload,
	}
	if remoteConn == nil {
		h.writeError(ctx, cc, &protocol.DecodeError{
			Code:    protocol.CodeNotInRoom,
			Message: "remote peer not present",
		}, d.Envelope.RequestID)
		return nil
	}
	if err := remoteConn.SendJSON(outEnv); err != nil {
		// Write failed — ICE is best-effort for protocol purposes but
		// the structured log must still reflect reality. Emit the
		// warning, do NOT fall through to the "relayed" success line.
		// ICE loss shows up on the remote peer as "no candidate ever
		// arrived" and is surfaced there via the Learning Inspector
		// end-of-candidates signal.
		h.Log.Warn("ice_candidate relay failed",
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
	h.Log.Info("ice_candidate relayed",
		slog.String("event", "ice_candidate_relay"),
		slog.String("from_peer_id", cc.peerID),
		slog.String("to_peer_id", remotePeerID),
		slog.Bool("end_of_candidates", endOfCandidates),
	)
	return nil
}

// ---------------------------------------------------------------------
// Phase 10 — media_state relay (T074A)
// ---------------------------------------------------------------------

// handleMediaState validates the sender's state per contract §3.11
// (mediaReadiness == ready; callPhase ∈ {role-assigned, negotiating,
// connected}) via room.CanSendMediaState and relays the payload bytes
// verbatim to the remote peer only. envelope.from is stamped with the
// sender's peerID. The server MUST NOT log the mic / camera /
// screenShare values themselves — only the sender / receiver peer IDs.
//
// Full-triplet validation (microphone, camera, screenShare all
// required) is enforced at decode time by protocol.MediaStatePayload.Validate():
// a missing field decodes to "" which fails the enum switch.
func (h *Handler) handleMediaState(ctx context.Context, cc *oneToOneConn, d *protocol.Decoded) error {
	if cc.peerID == "" {
		h.writeError(ctx, cc, &protocol.DecodeError{
			Code:    protocol.CodeNotInRoom,
			Message: "media_state requires an admitted participant",
		}, d.Envelope.RequestID)
		return nil
	}
	rm := h.Rooms.Room(cc.roomID)
	if rm == nil {
		h.writeError(ctx, cc, &protocol.DecodeError{
			Code:    protocol.CodeNotInRoom,
			Message: "room not found",
		}, d.Envelope.RequestID)
		return nil
	}

	rm.Lock()
	p := rm.FindByPeerID(cc.peerID)
	if p == nil {
		rm.Unlock()
		h.writeError(ctx, cc, &protocol.DecodeError{
			Code:    protocol.CodeNotInRoom,
			Message: "participant not found",
		}, d.Envelope.RequestID)
		return nil
	}
	role := rm.AssignedRole(cc.peerID)
	if relayErr := p.CanSendMediaState(role); relayErr != nil {
		rm.Unlock()
		h.writeError(ctx, cc, &protocol.DecodeError{
			Code:    protocol.ErrorCode(relayErr.Code),
			Message: relayErr.Message,
		}, d.Envelope.RequestID)
		return nil
	}
	remote := rm.ResolveRemote(cc.peerID)
	if remote == nil {
		rm.Unlock()
		h.writeError(ctx, cc, &protocol.DecodeError{
			Code:    protocol.CodeNotInRoom,
			Message: "remote peer not present",
		}, d.Envelope.RequestID)
		return nil
	}
	remoteConn := remote.Conn
	remotePeerID := remote.PeerID
	rm.Unlock()

	// Relay payload bytes verbatim — the server never needs to parse
	// the on/off values to route the message. Only envelope metadata
	// is rewritten.
	outEnv := protocol.Envelope{
		V:       protocol.ContractVersion,
		Type:    protocol.TypeMediaState,
		RoomID:  cc.roomID,
		From:    cc.peerID,
		To:      remotePeerID,
		TS:      time.Now().UnixMilli(),
		Payload: d.Envelope.Payload,
	}
	if remoteConn == nil {
		h.writeError(ctx, cc, &protocol.DecodeError{
			Code:    protocol.CodeNotInRoom,
			Message: "remote peer not present",
		}, d.Envelope.RequestID)
		return nil
	}
	if err := remoteConn.SendJSON(outEnv); err != nil {
		h.Log.Warn("media_state relay failed",
			slog.String("peer_id", remotePeerID),
			slog.String("error", err.Error()))
		return nil
	}

	// Structured log — peer IDs only. MUST NOT log microphone / camera
	// / screenShare values (contract §3.11 confidentiality; on/off
	// state is user-observable signal, not server telemetry).
	h.Log.Info("media_state relayed",
		slog.String("event", "media_state_relay"),
		slog.String("from_peer_id", cc.peerID),
		slog.String("to_peer_id", remotePeerID),
	)
	return nil
}
