package signaling

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"

	"webrtc-lab/signaling/internal/room"
)

// Handler is the /ws upgrader + per-connection dispatcher.
//
// Phase 3 scope: admission flow (join_room / join_accepted /
// join_rejected / peer_presence_changed / leave_room / pre-pairing
// peer_left classification). Media-ready pairing, role assignment,
// and relay (offer / answer / ice_candidate / media_state) land in
// Phase 4.
type Handler struct {
	Log           *slog.Logger
	Heartbeat     HeartbeatConfig
	Rooms         *room.RoomManager
	AcceptOptions *websocket.AcceptOptions

	connSeq atomic.Uint64
}

// NewHandler returns a Handler with a fresh RoomManager and sensible
// defaults from env.
func NewHandler(log *slog.Logger) *Handler {
	if log == nil {
		log = slog.Default()
	}
	return &Handler{
		Log:       log,
		Heartbeat: LoadHeartbeatConfig(),
		Rooms:     room.NewRoomManager(),
		AcceptOptions: &websocket.AcceptOptions{
			// Dev convenience: allow WS from any origin so the Vite dev
			// server on a different port can connect. Phase 13 tightens
			// this for production.
			InsecureSkipVerify: true,
		},
	}
}

// connCtx carries per-WS mutable state. Wrapped in a struct so the
// room.Conn adapter and the read/write paths can share a single
// writeMu.
type connCtx struct {
	conn     *websocket.Conn
	writeMu  sync.Mutex
	connID   string
	peerID   string
	roomID   string
	released atomic.Bool // flipped true once the slot has been released
}

// sendJSON marshals v as a text frame, serialized by the conn's
// writeMu. Returns an error if the underlying Write fails.
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

// roomConn adapts a *connCtx to the room.Conn interface used by the
// room package to send messages to a participant.
type roomConn struct {
	ctx *connCtx
	// baseCtx is a context suitable for writes — typically r.Context()
	// of the serving request. Captured at adapter creation.
	baseCtx context.Context
}

func (r *roomConn) SendJSON(v any) error {
	return r.ctx.sendJSON(r.baseCtx, v)
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, h.AcceptOptions)
	if err != nil {
		h.Log.Warn("websocket accept failed",
			slog.String("event", "ws_accept_failed"),
			slog.String("remote_addr", r.RemoteAddr),
			slog.String("error", err.Error()),
		)
		return
	}

	cc := &connCtx{
		conn:   conn,
		connID: formatConnID(h.connSeq.Add(1)),
	}

	h.Log.Info("websocket connected",
		slog.String("event", "ws_connected"),
		slog.String("conn_id", cc.connID),
		slog.String("remote_addr", r.RemoteAddr),
	)

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	// Heartbeat goroutine.
	heartbeatDone := make(chan error, 1)
	go func() {
		heartbeatDone <- runHeartbeat(ctx, conn, h.Heartbeat, h.Log, cc.connID)
	}()

	readErr := h.readLoop(ctx, cc)

	// Whichever side terminated first, stop the other.
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

	// Post-disconnect cleanup: if the connection was admitted and not
	// already released by an explicit leave_room, release the slot and
	// notify the remaining peer.
	if cc.peerID != "" && !cc.released.Load() {
		h.releaseAndNotify(context.Background(), cc, "disconnect")
	}

	_ = conn.Close(websocket.StatusNormalClosure, "bye")

	logAttrs := []any{
		slog.String("event", "ws_disconnected"),
		slog.String("conn_id", cc.connID),
		slog.String("reason", reason),
	}
	if cc.peerID != "" {
		logAttrs = append(logAttrs, slog.String("peer_id", cc.peerID))
	}
	h.Log.Info("websocket disconnected", logAttrs...)
}

func (h *Handler) readLoop(ctx context.Context, cc *connCtx) error {
	for {
		_, raw, err := cc.conn.Read(ctx)
		if err != nil {
			return err
		}

		decoded, derr := Decode(raw)
		if derr != nil {
			var de *DecodeError
			errors.As(derr, &de)
			h.writeError(ctx, cc, de, "")
			h.Log.Debug("decode error",
				slog.String("conn_id", cc.connID),
				slog.String("code", string(de.Code)),
			)
			continue
		}

		if err := h.dispatch(ctx, cc, decoded); err != nil {
			// dispatch errors are already surfaced to the client via
			// writeError; log and continue.
			h.Log.Debug("dispatch error",
				slog.String("conn_id", cc.connID),
				slog.String("type", string(decoded.Envelope.Type)),
				slog.String("error", err.Error()),
			)
		}
	}
}

// dispatch routes a decoded envelope to the correct Phase 3 handler.
// Unknown-for-Phase-3 types are rejected with an `error` frame; this
// prevents a client from accidentally advancing state via a message
// type that has not been wired yet.
func (h *Handler) dispatch(ctx context.Context, cc *connCtx, d *Decoded) error {
	switch d.Envelope.Type {
	case TypeJoinRoom:
		return h.handleJoinRoom(ctx, cc, d)
	case TypeLeaveRoom:
		return h.handleLeaveRoom(ctx, cc, d)
	case TypeMediaReady, TypeMediaFailed, TypeReadyForOffer,
		TypeOffer, TypeAnswer, TypeIceCandidate, TypeMediaState:
		// Phase 4+ territory — explicitly rejected here so a malformed
		// client cannot drive state we have not built yet.
		h.writeError(ctx, cc, &DecodeError{
			Code:    CodeMalformed,
			Message: "message type not yet supported (Phase 4+)",
		}, d.Envelope.RequestID)
		return nil
	case TypeJoinAccepted, TypeJoinRejected, TypePeerPresenceChanged,
		TypePeerLeft, TypeParticipantReleased:
		// These are server-originated; a client sending them is a bug.
		h.writeError(ctx, cc, &DecodeError{
			Code:    CodeMalformed,
			Message: "server-originated message received from client",
		}, d.Envelope.RequestID)
		return nil
	case TypeError:
		// Clients may send `error` back to flag inbound-validation
		// failures. Log and drop — the server treats these as
		// informational.
		h.Log.Debug("client-reported error",
			slog.String("conn_id", cc.connID),
		)
		return nil
	}
	return nil
}

func (h *Handler) handleJoinRoom(ctx context.Context, cc *connCtx, d *Decoded) error {
	if cc.peerID != "" {
		h.writeError(ctx, cc, &DecodeError{
			Code:    CodeAlreadyJoined,
			Message: "this connection has already joined a room",
		}, d.Envelope.RequestID)
		return nil
	}

	roomID := d.Envelope.RoomID
	if err := ValidateRoomID(roomID); err != nil {
		// Contract §3.1 + §3.3 route invalid IDs to join_rejected, not
		// the generic `error` message, because it is a terminal
		// admission outcome not a protocol violation.
		h.sendJoinRejected(ctx, cc, roomID, d.Envelope.RequestID,
			JoinRejectedInvalidRoom, ReasonInvalidRoomID,
			"room ID must match ^[A-Za-z0-9._-]{1,64}$.")
		return nil
	}

	outcome := h.Rooms.Admit(roomID, &roomConn{ctx: cc, baseCtx: ctx})

	switch outcome.Result {
	case room.JoinRejectedInvalidRoom:
		h.sendJoinRejected(ctx, cc, roomID, d.Envelope.RequestID,
			JoinRejectedInvalidRoom, ReasonInvalidRoomID,
			"room ID must match ^[A-Za-z0-9._-]{1,64}$.")
		return nil

	case room.JoinRejectedRoomFull:
		h.sendJoinRejected(ctx, cc, roomID, d.Envelope.RequestID,
			JoinRejectedRoomFull, ReasonRoomFull,
			"Room '"+roomID+"' already has two reserved participants.")
		return nil

	case room.JoinAccepted:
		cc.peerID = outcome.Participant.PeerID
		cc.roomID = outcome.Participant.RoomID
	}

	// Snapshot the remote peer (if any) under the room lock so the
	// join_accepted payload reflects the state at admission time.
	outcome.Room.Lock()
	var remote *RemotePeerSnapshot
	if r := outcome.Room.Remote(outcome.Participant.PeerID); r != nil {
		remote = &RemotePeerSnapshot{
			PeerID:         r.PeerID,
			MediaReadiness: toWireMediaReadiness(r.MediaReadiness),
		}
	}
	readiness := toWireRoomReadiness(outcome.Room.CallReadiness())
	admissionOrder := outcome.Participant.AdmissionOrder
	outcome.Room.Unlock()

	payload, _ := json.Marshal(JoinAcceptedPayload{
		PeerID:         outcome.Participant.PeerID,
		AdmissionOrder: admissionOrder,
		RoomReadiness:  readiness,
		RemotePeer:     remote,
	})
	env := Envelope{
		V:         ContractVersion,
		Type:      TypeJoinAccepted,
		RoomID:    roomID,
		RequestID: d.Envelope.RequestID,
		TS:        time.Now().UnixMilli(),
		Payload:   payload,
	}
	if err := cc.sendJSON(ctx, env); err != nil {
		h.Log.Warn("join_accepted send failed",
			slog.String("conn_id", cc.connID), slog.String("error", err.Error()))
	}

	// Broadcast the admission event to both reserved participants (§3.4,
	// §T025 DoD — including the subject).
	h.broadcastPresence(ctx, outcome.Room, outcome.Participant,
		PresencePendingMedia, PresenceReasonAdmitted)

	h.Log.Info("peer admitted",
		slog.String("event", "peer_admitted"),
		slog.String("conn_id", cc.connID),
		slog.String("peer_id", cc.peerID),
		slog.String("room_id", cc.roomID),
		slog.Int("admission_order", admissionOrder),
	)
	return nil
}

func (h *Handler) handleLeaveRoom(ctx context.Context, cc *connCtx, d *Decoded) error {
	if cc.peerID == "" {
		h.writeError(ctx, cc, &DecodeError{
			Code:    CodeNotInRoom,
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
	_ = cc.conn.Close(websocket.StatusNormalClosure, "graceful_leave")
	return nil
}

// releaseAndNotify runs the canonical server-side cleanup sequence
// from data-model §C.6 for a single departing participant. reason is
// either "graceful_leave" (leave_room) or "disconnect" (WS close /
// heartbeat timeout).
//
// Classification happens BEFORE the slot is mutated so the
// in-call-vs-pre-pairing decision is based on the participant's
// CallPhase at the moment of departure.
//
// Phase 3 only ever sees CallPhaseIdle (since media_ready isn't wired
// yet), so in practice the peer_left branch is dormant here — but the
// classification code is present so the later phases do not need to
// re-plumb this path.
func (h *Handler) releaseAndNotify(_ context.Context, cc *connCtx, reason string) {
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
	inCall := false
	if p != nil {
		inCall = room.IsInCall(p.CallPhase)
	}
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

	var presence Presence
	var presReason PresenceReason
	if inCall {
		presence = PresenceLeft
	} else {
		presence = PresenceReleased
	}
	switch reason {
	case "graceful_leave":
		presReason = PresenceReasonGracefulLeave
	case "disconnect":
		presReason = PresenceReasonDisconnect
	default:
		presReason = PresenceReasonDisconnect
	}

	// peer_presence_changed is ALWAYS sent on departure (§C.6 step 4).
	presencePayload, _ := json.Marshal(PeerPresenceChangedPayload{
		SubjectPeerID:  outcome.Departing.PeerID,
		AdmissionOrder: outcome.Departing.AdmissionOrder,
		Presence:       presence,
		Reason:         presReason,
	})
	presenceEnv := Envelope{
		V:       ContractVersion,
		Type:    TypePeerPresenceChanged,
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
	if inCall {
		var peerLeftReason PeerLeftReason
		if reason == "graceful_leave" {
			peerLeftReason = PeerLeftGracefulLeave
		} else {
			peerLeftReason = PeerLeftDisconnect
		}
		payload, _ := json.Marshal(PeerLeftPayload{
			PeerID: outcome.Departing.PeerID,
			Reason: peerLeftReason,
		})
		env := Envelope{
			V:       ContractVersion,
			Type:    TypePeerLeft,
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
		slog.Bool("in_call", inCall),
		slog.Bool("room_gc", outcome.RoomGarbageCollected),
	)
}

// broadcastPresence sends peer_presence_changed to every reserved
// slot in the room (contract §3.4 "S→B to both reserved
// participants, including the subject").
func (h *Handler) broadcastPresence(_ context.Context, r *room.Room, subject *room.Participant, presence Presence, reason PresenceReason) {
	r.Lock()
	targets := r.Participants()
	r.Unlock()

	payload, _ := json.Marshal(PeerPresenceChangedPayload{
		SubjectPeerID:  subject.PeerID,
		AdmissionOrder: subject.AdmissionOrder,
		Presence:       presence,
		Reason:         reason,
	})
	env := Envelope{
		V:       ContractVersion,
		Type:    TypePeerPresenceChanged,
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

func (h *Handler) writeError(ctx context.Context, cc *connCtx, de *DecodeError, correlates string) {
	payload, _ := json.Marshal(ErrorPayload{
		Code:       de.Code,
		Message:    de.Message,
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

// ---------------------------------------------------------------------
// room → wire enum mapping
// ---------------------------------------------------------------------

func toWireMediaReadiness(m room.MediaReadiness) MediaReadiness {
	switch m {
	case room.MediaReadinessReady:
		return MediaReady
	}
	return MediaPending
}

func toWireRoomReadiness(c room.CallReadiness) RoomReadiness {
	switch c {
	case room.CallReadinessEmpty:
		return RoomEmpty
	case room.CallReadinessWaitingForMedia:
		return RoomWaitingForMedia
	case room.CallReadinessWaitingForPeer:
		return RoomWaitingForPeer
	case room.CallReadinessPaired:
		return RoomPaired
	}
	return RoomEmpty
}

// ---------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------

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
	return "c-" + strconv.FormatUint(n, 10)
}
