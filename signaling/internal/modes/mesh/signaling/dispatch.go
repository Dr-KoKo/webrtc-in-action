package signaling

import (
	"context"
	"errors"

	"webrtc-lab/signaling/internal/modes/mesh/protocol"
)

// errNotMigrated is the placeholder returned by Dispatch until verb
// methods land in commit 2.B2. mesh/handler.go still owns the live
// dispatch path during 2.B1; this stub exists so callers can
// reference signaling.Service.Dispatch in the future without a
// second package boundary churn.
var errNotMigrated = errors.New("mesh signaling.Service.Dispatch is not yet wired (lands in commit 2.B2)")

// Dispatch routes a decoded envelope to the correct verb method.
// Stub during 2.B1; populated in 2.B2.
func (s *Service) Dispatch(_ context.Context, _ Conn, _ *protocol.Decoded) error {
	return errNotMigrated
}
