package mesh_test

import (
	"errors"

	protocol "webrtc-lab/signaling/internal/modes/mesh/protocol"
)

// asProtocolError is a tiny errors.As wrapper that returns true if the
// target was populated. Lets callers chain on the bool.
func asProtocolError(err error, target **protocol.ProtocolError) bool {
	return errors.As(err, target)
}
