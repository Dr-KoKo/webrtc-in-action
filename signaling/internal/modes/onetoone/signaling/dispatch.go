package signaling

import (
	"context"
	"errors"

	"webrtc-lab/signaling/internal/modes/onetoone/protocol"
)

// errNotMigrated is the placeholder returned by Dispatch until verb
// methods land in commit 1.B2. handler.go still owns the live
// dispatch path during 1.B1; this stub exists so callers can
// reference signaling.Service.Dispatch in the future without a
// second package boundary churn.
var errNotMigrated = errors.New("signaling.Service.Dispatch is not yet wired (lands in commit 1.B2)")

// Dispatch routes a decoded envelope to the correct verb method.
// Stub during 1.B1; populated in 1.B2.
func (s *Service) Dispatch(_ context.Context, _ Conn, _ *protocol.Decoded) error {
	return errNotMigrated
}
