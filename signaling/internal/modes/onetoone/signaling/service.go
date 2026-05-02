package signaling

import (
	"log/slog"

	"webrtc-lab/signaling/internal/modes/onetoone/protocol"
	"webrtc-lab/signaling/internal/modes/onetoone/room"
)

// Service hosts the WebRTC verbs for the 001 contract. It owns no
// per-connection state; per-conn state lives on the Conn interface.
// The Service holds only cross-connection collaborators (room
// manager, ICE config) and the logger.
//
// Verb method bodies land in commit 1.B2. The skeleton exists in
// 1.B1 to establish the type and the import direction so handler.go
// can shrink in two reviewable diffs instead of one ~1,400-line
// patch.
type Service struct {
	Log   *slog.Logger
	Rooms *room.RoomManager
	ICE   []protocol.IceServer
}

// NewService returns a Service wired to the given collaborators.
// log may be nil; in that case slog.Default() is used.
func NewService(log *slog.Logger, rooms *room.RoomManager, ice []protocol.IceServer) *Service {
	if log == nil {
		log = slog.Default()
	}
	return &Service{
		Log:   log,
		Rooms: rooms,
		ICE:   ice,
	}
}
