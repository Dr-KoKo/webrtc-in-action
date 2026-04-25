package mesh_test

import (
	"errors"

	"webrtc-lab/signaling/internal/mesh"
)

// asProtocolError is a tiny errors.As wrapper that returns true if the
// target was populated. Lets callers chain on the bool.
func asProtocolError(err error, target **mesh.ProtocolError) bool {
	return errors.As(err, target)
}
