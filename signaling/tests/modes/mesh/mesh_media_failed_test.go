// T042 — `media_failed` releases the slot and the admission_index is
// not reused (data-model §A.4 / §C.4 + contract §3.7 + §3.8).
//
// Scenarios:
//   - 4 clients admitted; the 4th sends `media_failed`; the 4th gets
//     `participant_released`; the remaining 3 get a `mesh_roster_update`
//     with `presence: "released", reason: "media_failed"`.
//   - A new (5th) `join_room` succeeds because the 4th's slot was
//     freed.
//   - The new joiner's `admissionIndex` is strictly greater than the
//     departed 4th's — never reused.
//   - The failing client's WS stays open so the user may Retry.

package mesh_test

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/coder/websocket"

	"webrtc-lab/signaling/internal/modes/mesh"

	protocol "webrtc-lab/signaling/internal/modes/mesh/protocol"
)

// readMeshFrame reads one frame and returns its envelope + raw payload.
func readMeshFrame(t *testing.T, conn *websocket.Conn, ctx context.Context) protocol.Envelope {
	t.Helper()
	_, raw, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read failed: %v", err)
	}
	var env protocol.Envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatalf("envelope unmarshal failed: %v", err)
	}
	return env
}

// readMeshFrameOfType keeps reading until the requested type arrives or
// the context times out. Useful when the server may interleave
// snapshot/update frames around the asserted one.
func readMeshFrameOfType(t *testing.T, conn *websocket.Conn, ctx context.Context, want protocol.MessageType) protocol.Envelope {
	t.Helper()
	for {
		env := readMeshFrame(t, conn, ctx)
		if env.Type == want {
			return env
		}
	}
}

// TestMediaFailedReleasesSlotAndDoesNotReuseAdmissionIndex covers the
// canonical M5 / EC-003 post-admission release flow.
func TestMediaFailedReleasesSlotAndDoesNotReuseAdmissionIndex(t *testing.T) {
	h := mesh.NewHandler(silentLogger(), defaultModeConfig())
	ts := httptest.NewServer(h)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	const roomID = "demo"
	conns := make([]*websocket.Conn, 0, 4)
	indices := make([]uint64, 0, 4)
	for i := 1; i <= 4; i++ {
		c, _, idx := joinAndExpectAccepted(t, ts, ctx, roomID)
		// Drain snapshot + roster_update for this conn so subsequent
		// reads start fresh.
		_ = drainMeshFrames(t, c, ctx, 2)
		conns = append(conns, c)
		indices = append(indices, idx)
	}
	// Drain the i'th roster_update for earlier conns so they also
	// start fresh.
	// Specifically: when conn[i] joined, conn[0..i-1] each received an
	// extra mesh_roster_update for the new joiner. drainConnUpdates
	// walks each earlier conn through the right number of joiner
	// updates.
	for earlier := 0; earlier < 4; earlier++ {
		toDrain := 3 - earlier // updates for joiners admitted after this one
		for d := 0; d < toDrain; d++ {
			env := readMeshFrame(t, conns[earlier], ctx)
			if env.Type != protocol.TypeMeshRosterUpdate {
				t.Fatalf("earlier=%d expected mesh_roster_update; got %q", earlier, env.Type)
			}
		}
	}

	// Conn[3] (the 4th joiner, admissionIndex = 4) sends media_failed.
	failing := conns[3]
	failedRoomID := roomID
	failedReq := []byte(`{"v":2,"type":"media_failed","roomId":"` + failedRoomID +
		`","payload":{"reason":"permission_denied","detail":"camera_permission_denied"}}`)
	if err := failing.Write(ctx, websocket.MessageText, failedReq); err != nil {
		t.Fatalf("write media_failed failed: %v", err)
	}

	// The failing peer should receive participant_released first.
	released := readMeshFrameOfType(t, failing, ctx, protocol.TypeParticipantReleased)
	var rp protocol.ParticipantReleasedPayload
	if err := json.Unmarshal(released.Payload, &rp); err != nil {
		t.Fatalf("participant_released payload unmarshal: %v", err)
	}
	if rp.Result != protocol.ParticipantReleasedMediaFailed {
		t.Fatalf("released.result = %q, want %q", rp.Result, protocol.ParticipantReleasedMediaFailed)
	}
	if rp.Reason != protocol.ReleasedReasonMediaFailed {
		t.Fatalf("released.reason = %q, want %q", rp.Reason, protocol.ReleasedReasonMediaFailed)
	}

	// Remaining three peers should each receive a mesh_roster_update
	// with presence:released, reason:media_failed for the failing peer.
	for r := 0; r < 3; r++ {
		env := readMeshFrameOfType(t, conns[r], ctx, protocol.TypeMeshRosterUpdate)
		var up protocol.MeshRosterUpdatePayload
		if err := json.Unmarshal(env.Payload, &up); err != nil {
			t.Fatalf("update payload unmarshal: %v", err)
		}
		if up.Presence != protocol.PresenceReleased {
			t.Fatalf("conn[%d] update.presence = %q, want %q", r, up.Presence, protocol.PresenceReleased)
		}
		if up.Reason != protocol.RosterReasonMediaFailed {
			t.Fatalf("conn[%d] update.reason = %q, want %q", r, up.Reason, protocol.RosterReasonMediaFailed)
		}
		if up.AdmissionIndex != indices[3] {
			t.Fatalf("conn[%d] update.admissionIndex = %d, want %d", r, up.AdmissionIndex, indices[3])
		}
	}

	// A 5th joiner can now be admitted because the 4th's slot is free.
	// admission_index must be strictly greater than the released 4th's.
	fresh, _, idxFresh := joinAndExpectAccepted(t, ts, ctx, roomID)
	defer fresh.CloseNow()
	if idxFresh <= indices[3] {
		t.Fatalf("fresh admission_index = %d, must be > released %d (no reuse)", idxFresh, indices[3])
	}
	if idxFresh != 5 {
		t.Fatalf("fresh admission_index = %d, want 5 (strictly monotonic)", idxFresh)
	}

	for _, c := range conns {
		_ = c.Close(websocket.StatusNormalClosure, "bye")
	}
}

// TestMediaReadyBroadcastsRosterUpdate covers the §3.6 happy path:
// after `media_ready`, every participant in the room receives a
// `mesh_roster_update { presence: "media-ready", reason: "media_ready" }`.
func TestMediaReadyBroadcastsRosterUpdate(t *testing.T) {
	h := mesh.NewHandler(silentLogger(), defaultModeConfig())
	ts := httptest.NewServer(h)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	const roomID = "ready"
	a, _, idxA := joinAndExpectAccepted(t, ts, ctx, roomID)
	defer a.CloseNow()
	_ = drainMeshFrames(t, a, ctx, 2) // snapshot + own roster_update

	b, _, _ := joinAndExpectAccepted(t, ts, ctx, roomID)
	defer b.CloseNow()
	_ = drainMeshFrames(t, b, ctx, 2)
	// A also received a roster_update for B's join.
	_ = readMeshFrameOfType(t, a, ctx, protocol.TypeMeshRosterUpdate)

	// A sends media_ready.
	req := []byte(`{"v":2,"type":"media_ready","roomId":"` + roomID + `","payload":{"mediaCapabilities":{"audio":true,"video":true}}}`)
	if err := a.Write(ctx, websocket.MessageText, req); err != nil {
		t.Fatalf("media_ready write failed: %v", err)
	}

	// Both A and B should receive the roster_update for A → media-ready.
	for _, c := range []*websocket.Conn{a, b} {
		env := readMeshFrameOfType(t, c, ctx, protocol.TypeMeshRosterUpdate)
		var up protocol.MeshRosterUpdatePayload
		if err := json.Unmarshal(env.Payload, &up); err != nil {
			t.Fatalf("update payload unmarshal: %v", err)
		}
		if up.Presence != protocol.PresenceMediaReady {
			t.Fatalf("update.presence = %q, want %q", up.Presence, protocol.PresenceMediaReady)
		}
		if up.Reason != protocol.RosterReasonMediaReady {
			t.Fatalf("update.reason = %q, want %q", up.Reason, protocol.RosterReasonMediaReady)
		}
		if up.AdmissionIndex != idxA {
			t.Fatalf("update.admissionIndex = %d, want %d", up.AdmissionIndex, idxA)
		}
	}
}

// TestMediaReadyFromNonJoinedRejected — sending media_ready a second
// time (when readiness is already media-ready) returns
// `error { code: "unexpected_media_ready" }`.
func TestMediaReadyFromNonJoinedRejected(t *testing.T) {
	h := mesh.NewHandler(silentLogger(), defaultModeConfig())
	ts := httptest.NewServer(h)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	const roomID = "twice"
	a, _, _ := joinAndExpectAccepted(t, ts, ctx, roomID)
	defer a.CloseNow()
	_ = drainMeshFrames(t, a, ctx, 2)

	req := []byte(`{"v":2,"type":"media_ready","roomId":"` + roomID + `","payload":{"mediaCapabilities":{"audio":true,"video":true}}}`)
	if err := a.Write(ctx, websocket.MessageText, req); err != nil {
		t.Fatalf("first media_ready write failed: %v", err)
	}
	// Drain the broadcast to A.
	_ = readMeshFrameOfType(t, a, ctx, protocol.TypeMeshRosterUpdate)

	// Second attempt should yield error unexpected_media_ready.
	if err := a.Write(ctx, websocket.MessageText, req); err != nil {
		t.Fatalf("second media_ready write failed: %v", err)
	}
	got := expectErrorEnvelope(t, a, ctx)
	if got != protocol.CodeUnexpectedMediaReady {
		t.Fatalf("error.code = %q, want %q", got, protocol.CodeUnexpectedMediaReady)
	}
}
