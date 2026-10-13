package wsserver

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"sync/atomic"

	"github.com/coder/websocket"

	"webrtc-lab/signaling/internal/shared/heartbeat"
)

// LogLine is the per-event log shape: the slog `event` field value
// and the log message text. Each mode supplies its own LogLine
// values for connect / disconnect / accept-failed so today's
// observable strings ("websocket connected" vs
// "mesh websocket connected", etc.) are preserved verbatim.
type LogLine struct {
	Event   string
	Message string
}

// Config bundles the per-handler settings the skeleton needs. Built
// by each mode from its ModeConfig and handed to New(). All fields
// are values; the skeleton snapshots them at construction.
//
// Origin policy: exactly one of InsecureSkipVerify or OriginPatterns
// is meaningful. coder/websocket.AcceptOptions semantics —
// InsecureSkipVerify=true allows any origin; OriginPatterns non-empty
// restricts to the listed origins (same-origin always implicit).
// The mode's caller (config.Load + handler) is responsible for not
// setting both.
type Config struct {
	Heartbeat          heartbeat.Config
	HeartbeatLabels    heartbeat.Labels
	Logger             *slog.Logger
	InsecureSkipVerify bool
	OriginPatterns     []string
	ConnIDPrefix       string
	Connect            LogLine
	Disconnect         LogLine
	AcceptFailed       LogLine
}

// Server is the http.Handler that owns one WebSocket session
// lifecycle per request. The conn-id counter (seq) lives here so
// IDs are stable across requests within one Server, matching
// today's per-Handler atomic.Uint64 (onetoone:41, mesh:46).
type Server struct {
	cfg    Config
	accept websocket.AcceptOptions
	mode   Mode
	seq    atomic.Uint64
}

// New constructs a Server. Logger is required. AcceptOptions are
// derived from cfg.InsecureSkipVerify / cfg.OriginPatterns once at
// construction; subsequent Accept calls reuse the same struct.
func New(mode Mode, cfg Config) *Server {
	if cfg.Logger == nil {
		panic("wsserver.New: Config.Logger is required")
	}
	return &Server{
		cfg: cfg,
		accept: websocket.AcceptOptions{
			InsecureSkipVerify: cfg.InsecureSkipVerify,
			OriginPatterns:     cfg.OriginPatterns,
		},
		mode: mode,
	}
}

// ServeHTTP runs one signaling session end-to-end:
//   1. accept the WS upgrade
//   2. assign conn-id, log connect
//   3. ask the Mode for a SessionHandler (refusal contract: see
//      Mode.NewSession docs)
//   4. launch heartbeat goroutine
//   5. run read loop (mode HandleFrame per frame)
//   6. on read exit: cancel readCtx, await heartbeat
//   7. classify disconnect cause (readErr beats hbErr — same
//      precedence as today's onetoone:155-166 / mesh:118-129)
//   8. call OnDisconnect(transportReason) — no ctx; mode uses
//      context.Background() for cleanup writes
//   9. close conn (idempotent; tolerates heartbeat CloseNow having
//      run already)
//  10. emit disconnect log line with merged attrs
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, &s.accept)
	if err != nil {
		s.cfg.Logger.Warn(s.cfg.AcceptFailed.Message,
			slog.String("event", s.cfg.AcceptFailed.Event),
			slog.String("remote_addr", r.RemoteAddr),
			slog.String("error", err.Error()),
		)
		return
	}

	connID := s.cfg.ConnIDPrefix + strconv.FormatUint(s.seq.Add(1), 10)

	s.cfg.Logger.Info(s.cfg.Connect.Message,
		slog.String("event", s.cfg.Connect.Event),
		slog.String("conn_id", connID),
		slog.String("remote_addr", r.RemoteAddr),
	)

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	sess := &sessionImpl{
		conn:    conn,
		id:      connID,
		baseCtx: ctx,
	}

	handler, err := s.mode.NewSession(sess, s.cfg.Logger)
	if err != nil {
		// Refusal contract: connect log already emitted; close with
		// StatusInternalError + "newsession_refused"; emit a
		// disconnect log with reason="newsession_refused" and the
		// error in a "refuse_error" attr; do NOT call OnDisconnect.
		_ = sess.Close(websocket.StatusInternalError, "newsession_refused")
		s.cfg.Logger.Info(s.cfg.Disconnect.Message,
			slog.String("event", s.cfg.Disconnect.Event),
			slog.String("conn_id", connID),
			slog.String("reason", "newsession_refused"),
			slog.String("refuse_error", err.Error()),
		)
		return
	}

	heartbeatDone := make(chan error, 1)
	go func() {
		heartbeatDone <- heartbeat.Run(ctx, conn, s.cfg.Heartbeat, s.cfg.Logger, connID, s.cfg.HeartbeatLabels)
	}()

	readErr := s.runReadLoop(ctx, sess, handler)

	cancel()
	hbErr := <-heartbeatDone

	reason := "closed"
	switch {
	case readErr != nil:
		reason = classifyReadError(readErr)
	case hbErr != nil && !errors.Is(hbErr, context.Canceled):
		var herr *heartbeat.HeartbeatError
		if errors.As(hbErr, &herr) {
			reason = herr.Reason
		} else {
			reason = "heartbeat_error"
		}
	}

	extraAttrs := handler.OnDisconnect(reason)

	_ = sess.Close(websocket.StatusNormalClosure, "bye")

	attrs := []any{
		slog.String("event", s.cfg.Disconnect.Event),
		slog.String("conn_id", connID),
		slog.String("reason", reason),
	}
	for _, a := range extraAttrs {
		attrs = append(attrs, a)
	}
	s.cfg.Logger.Info(s.cfg.Disconnect.Message, attrs...)
}

func (s *Server) runReadLoop(ctx context.Context, sess *sessionImpl, h SessionHandler) error {
	for {
		_, raw, err := sess.conn.Read(ctx)
		if err != nil {
			return err
		}
		// Non-nil HandleFrame return is ALWAYS terminal — modes log
		// their non-fatal errors internally and return nil. This
		// preserves today's mode-specific decode/dispatch error
		// fields (code/type) by keeping the log line on the mode
		// side.
		if err := h.HandleFrame(ctx, raw); err != nil {
			return err
		}
	}
}
