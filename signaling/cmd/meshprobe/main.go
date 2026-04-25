// meshprobe — one-shot CLI that drives the manual-verification
// checklist against a running /ws/mesh endpoint. Hits steps 3–9 of
// the M0–M3 batch's manual check list. Builds standalone with `go run
// ./cmd/meshprobe ws://localhost:8080/ws/mesh`. Not part of the
// production binary.

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/coder/websocket"
)

const room = "demo"

type envelope struct {
	V         int             `json:"v"`
	Type      string          `json:"type"`
	RoomID    string          `json:"roomId,omitempty"`
	From      string          `json:"from,omitempty"`
	To        string          `json:"to,omitempty"`
	RequestID string          `json:"requestId,omitempty"`
	TS        int64           `json:"ts,omitempty"`
	Payload   json.RawMessage `json:"payload,omitempty"`
}

type joinAccepted struct {
	PeerID         string `json:"peerId"`
	AdmissionIndex uint64 `json:"admissionIndex"`
}

type joinRejected struct {
	Result  string `json:"result"`
	Reason  string `json:"reason"`
	Message string `json:"message"`
}

type rosterUpdate struct {
	ServerSeq      uint64 `json:"serverSeq"`
	SubjectPeerID  string `json:"subjectPeerId"`
	AdmissionIndex uint64 `json:"admissionIndex"`
	Presence       string `json:"presence"`
	Reason         string `json:"reason"`
}

func reqID(i int) string { return fmt.Sprintf("deadbeef-0000-4000-8000-%012d", i) }

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: meshprobe ws://host:port/ws/mesh")
		os.Exit(2)
	}
	url := os.Args[1]
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	// Step 3 — connect four mesh clients.
	conns := make([]*websocket.Conn, 4)
	indices := make([]uint64, 4)
	peerIDs := make([]string, 4)
	for i := 0; i < 4; i++ {
		c, _, err := websocket.Dial(ctx, url, nil)
		if err != nil {
			die("dial #%d failed: %v", i+1, err)
		}
		conns[i] = c
		// Send join_room.
		req := []byte(fmt.Sprintf(`{"v":2,"type":"join_room","roomId":%q,"requestId":%q,"payload":{}}`, room, reqID(i+1)))
		if err := c.Write(ctx, websocket.MessageText, req); err != nil {
			die("join write #%d failed: %v", i+1, err)
		}
		acc := mustReadType(ctx, c, "join_accepted")
		var jp joinAccepted
		_ = json.Unmarshal(acc.Payload, &jp)
		indices[i] = jp.AdmissionIndex
		peerIDs[i] = jp.PeerID
		_ = mustReadType(ctx, c, "mesh_roster_snapshot")
		fmt.Printf("step3: client #%d admitted peerId=%s admissionIndex=%d\n", i+1, jp.PeerID, jp.AdmissionIndex)
	}

	// Step 4 — confirm all four receive roster snapshots and updates.
	// Each client gets one mesh_roster_update per admission; client #i
	// receives (4 − i) further admission updates (for joins after it).
	for i := 0; i < 4; i++ {
		expected := 4 - i // each client also gets its own admission update
		seqs := make([]uint64, 0, expected)
		for k := 0; k < expected; k++ {
			frame := mustReadType(ctx, conns[i], "mesh_roster_update")
			var ru rosterUpdate
			_ = json.Unmarshal(frame.Payload, &ru)
			seqs = append(seqs, ru.ServerSeq)
		}
		fmt.Printf("step4: client #%d received roster_update serverSeq=%v\n", i+1, seqs)
	}

	// Step 5+6 — connect a 5th client and confirm structured rejection.
	fifth, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		die("5th dial failed: %v", err)
	}
	defer fifth.CloseNow()
	req5 := []byte(fmt.Sprintf(`{"v":2,"type":"join_room","roomId":%q,"requestId":%q,"payload":{}}`, room, reqID(99)))
	t0 := time.Now()
	if err := fifth.Write(ctx, websocket.MessageText, req5); err != nil {
		die("5th write failed: %v", err)
	}
	rej := mustReadType(ctx, fifth, "join_rejected")
	dt := time.Since(t0)
	var jr joinRejected
	_ = json.Unmarshal(rej.Payload, &jr)
	fmt.Printf("step5+6: 5th rejected result=%s reason=%s after %v (SC-004 budget 2 s)\n", jr.Result, jr.Reason, dt)

	// Step 7+8+9 — disconnect client #2 (admissionIndex=2) and confirm
	// remaining peers receive a roster update presence:left, then
	// re-join to confirm the freed slot is reusable but admissionIndex
	// is NOT reused.
	leaveReq := []byte(fmt.Sprintf(`{"v":2,"type":"leave_room","roomId":%q,"payload":{}}`, room))
	if err := conns[1].Write(ctx, websocket.MessageText, leaveReq); err != nil {
		die("leave write failed: %v", err)
	}
	_ = conns[1].CloseNow()
	for i := 0; i < 4; i++ {
		if i == 1 {
			continue
		}
		frame := mustReadType(ctx, conns[i], "mesh_roster_update")
		var ru rosterUpdate
		_ = json.Unmarshal(frame.Payload, &ru)
		fmt.Printf("step7+8: client #%d saw left subject=%s presence=%s reason=%s seq=%d\n", i+1, ru.SubjectPeerID, ru.Presence, ru.Reason, ru.ServerSeq)
	}

	// Step 9 — reuse the freed slot (a fresh client should get index = 5).
	rejoin, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		die("rejoin dial failed: %v", err)
	}
	defer rejoin.CloseNow()
	req6 := []byte(fmt.Sprintf(`{"v":2,"type":"join_room","roomId":%q,"requestId":%q,"payload":{}}`, room, reqID(101)))
	if err := rejoin.Write(ctx, websocket.MessageText, req6); err != nil {
		die("rejoin write failed: %v", err)
	}
	acc := mustReadType(ctx, rejoin, "join_accepted")
	var ja joinAccepted
	_ = json.Unmarshal(acc.Payload, &ja)
	fmt.Printf("step9: rejoin admitted admissionIndex=%d (must be > old #2 admissionIndex %d)\n", ja.AdmissionIndex, indices[1])
	if ja.AdmissionIndex <= indices[1] {
		die("admissionIndex was reused: got %d, must be > %d", ja.AdmissionIndex, indices[1])
	}

	// Cleanup.
	for i, c := range conns {
		if i == 1 {
			continue
		}
		_ = c.Close(websocket.StatusNormalClosure, "bye")
	}
	fmt.Println("OK — manual verification steps 3–9 reproduced")
}

func mustReadType(ctx context.Context, c *websocket.Conn, want string) envelope {
	for {
		_, raw, err := c.Read(ctx)
		if err != nil {
			die("read for %q failed: %v", want, err)
		}
		var e envelope
		if err := json.Unmarshal(raw, &e); err != nil {
			die("envelope unmarshal failed: %v", err)
		}
		if e.Type == want {
			return e
		}
		fmt.Fprintf(os.Stderr, "[skip] saw %q while waiting for %q\n", e.Type, want)
	}
}

func die(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "ERROR: "+format+"\n", args...)
	os.Exit(1)
}
