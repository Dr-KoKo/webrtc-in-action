// Contract §1.1: room IDs are trimmed of leading / trailing whitespace
// before validation. The handler must accept "demo " (trailing space)
// and admit the joiner into the same room as "demo".
//
// Implementation: handleJoinRoom calls strings.TrimSpace at handler
// entry (mesh-only fix; 001 carries the same bug at three sites — see
// commit message for the deferred-001 TODO).

package mesh_test

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/coder/websocket"

	"webrtc-lab/signaling/internal/modes/mesh"
)

// TestJoinRoomAdmitsTrimmedRoomID — admits "demo " (trailing space)
// and confirms the resulting room is the same MeshRoom as "demo" (a
// second joiner using the un-trimmed form gets the next admission
// index in the same room).
func TestJoinRoomAdmitsTrimmedRoomID(t *testing.T) {
	h := mesh.NewHandler(silentLogger())
	ts := httptest.NewServer(h)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	const trimmedRoomID = "demo"

	// First joiner uses "demo " (trailing space).
	connA := dialMesh(t, ts, ctx)
	defer connA.CloseNow()
	reqA := []byte(`{"v":2,"type":"join_room","roomId":"demo ","requestId":"deadbeef-0000-4000-8000-000000000001","payload":{}}`)
	if err := connA.Write(ctx, websocket.MessageText, reqA); err != nil {
		t.Fatalf("write join_room (trimmed) failed: %v", err)
	}
	_, raw, err := connA.Read(ctx)
	if err != nil {
		t.Fatalf("read join_accepted (trimmed) failed: %v", err)
	}
	var envA mesh.Envelope
	if err := json.Unmarshal(raw, &envA); err != nil {
		t.Fatalf("envelope (trimmed) unmarshal: %v", err)
	}
	if envA.Type != mesh.TypeJoinAccepted {
		t.Fatalf("type = %q, want %q (trimmed)", envA.Type, mesh.TypeJoinAccepted)
	}
	if envA.RoomID != trimmedRoomID {
		t.Fatalf("envelope.roomId = %q, want %q (server should echo the trimmed form)",
			envA.RoomID, trimmedRoomID)
	}
	var payloadA mesh.JoinAcceptedPayload
	if err := json.Unmarshal(envA.Payload, &payloadA); err != nil {
		t.Fatalf("payload (trimmed) unmarshal: %v", err)
	}
	if payloadA.AdmissionIndex != 1 {
		t.Fatalf("first admission_index = %d, want 1", payloadA.AdmissionIndex)
	}
	// Drain snapshot + first roster_update so subsequent reads start clean.
	_ = drainMeshFrames(t, connA, ctx, 2)

	// Second joiner uses the explicit un-trimmed form. Must land in
	// the SAME room (admission_index 2, not a fresh 1).
	connB, _, idxB := joinAndExpectAccepted(t, ts, ctx, trimmedRoomID)
	defer connB.CloseNow()
	if idxB != 2 {
		t.Fatalf("second admission_index = %d, want 2 (same room as trimmed first joiner)", idxB)
	}
}

// TestJoinRoomRejectsRoomIDWithInteriorWhitespace — interior spaces
// don't satisfy the regex even after Trim. "de mo" stays invalid.
func TestJoinRoomRejectsRoomIDWithInteriorWhitespace(t *testing.T) {
	h := mesh.NewHandler(silentLogger())
	ts := httptest.NewServer(h)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn := dialMesh(t, ts, ctx)
	defer conn.CloseNow()
	req := []byte(`{"v":2,"type":"join_room","roomId":"de mo","requestId":"deadbeef-0000-4000-8000-000000000002","payload":{}}`)
	if err := conn.Write(ctx, websocket.MessageText, req); err != nil {
		t.Fatalf("write join_room failed: %v", err)
	}
	_, raw, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read join_rejected failed: %v", err)
	}
	var env mesh.Envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatalf("envelope unmarshal failed: %v", err)
	}
	if env.Type != mesh.TypeJoinRejected {
		t.Fatalf("type = %q, want %q", env.Type, mesh.TypeJoinRejected)
	}
	var rej mesh.JoinRejectedPayload
	if err := json.Unmarshal(env.Payload, &rej); err != nil {
		t.Fatalf("payload unmarshal failed: %v", err)
	}
	if rej.Result != mesh.JoinRejectedInvalidRoom {
		t.Fatalf("result = %q, want %q", rej.Result, mesh.JoinRejectedInvalidRoom)
	}
}
