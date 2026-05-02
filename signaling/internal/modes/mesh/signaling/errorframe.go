package signaling

import (
	"context"
	"encoding/json"
	"time"

	"webrtc-lab/signaling/internal/modes/mesh/protocol"
)

// writeError marshals a typed `error` envelope back to the sender.
// Used by every verb that needs to surface a contract violation.
//
// requestID is the inbound envelope's requestId, mirrored back as
// payload.correlates so the client can pair the error with the
// triggering request. Empty requestID omits the correlates field.
func (s *Service) writeError(ctx context.Context, conn Conn, perr *protocol.ProtocolError, requestID string) {
	if perr == nil {
		return
	}
	payload, _ := json.Marshal(protocol.ErrorPayload{
		Code:       perr.Code,
		Message:    perr.Message,
		Correlates: requestID,
	})
	env := protocol.Envelope{
		V:       protocol.ContractVersion,
		Type:    protocol.TypeError,
		TS:      time.Now().UnixMilli(),
		Payload: payload,
	}
	_ = conn.SendJSON(ctx, env)
}
