// T067 — chat event-log invariants (FR-061 + FR-053).
//
// Asserts:
//   - `mesh_chat_message_sent` entries carry pairId + remotePeerId.
//   - `mesh_chat_message_received` entries carry pairId + senderPeerId.
//   - `mesh_chat_message_send_skipped` entries carry pairId,
//     remotePeerId, and the current readyState.
//   - One local-echo dispatch produces NO duplicate event entries
//     for the same chat-event type per pair.

import { describe, expect, it, vi } from "vitest";
import {
  attachMeshChatReceiver,
  fanOutMeshChat,
  MESH_CHAT_PAYLOAD_KIND,
  type MeshChatSendablePair,
} from "../webrtc/dataChannel";
import type { MeshRootAction } from "../state";

class FakeOpenChannel {
  public readyState: RTCDataChannelState = "open";
  public onmessage: ((e: MessageEvent) => void) | null = null;
  public readonly sent: string[] = [];
  send(data: string) {
    this.sent.push(data);
  }
  emit(payload: unknown) {
    const data = typeof payload === "string" ? payload : JSON.stringify(payload);
    this.onmessage?.({ data } as MessageEvent);
  }
}

describe("chat event-log entries (FR-061 / FR-053)", () => {
  it("mesh_chat_message_sent includes pairId, remotePeerId, transport=datachannel", () => {
    const actions: MeshRootAction[] = [];
    const dispatch = vi.fn((a: MeshRootAction) => void actions.push(a));
    const dc = new FakeOpenChannel();
    const pairs: MeshChatSendablePair[] = [
      { pairId: "1-2", remotePeerId: "peer-b", dc: dc as unknown as RTCDataChannel },
    ];
    fanOutMeshChat(
      pairs,
      { messageId: "m1", roomId: "demo", senderPeerId: "self", text: "x", sentAt: 1 },
      { dispatch },
    );
    const sent = actions.find(
      (a) => a.type === "MESH_EVENT_APPEND" && a.entry.type === "mesh_chat_message_sent",
    );
    if (!sent || sent.type !== "MESH_EVENT_APPEND") throw new Error("no sent entry");
    expect(sent.entry.pairId).toBe("1-2");
    expect(sent.entry.peerId).toBe("peer-b");
    expect(sent.entry.detail).toMatchObject({
      transport: "datachannel",
      messageId: "m1",
    });
  });

  it("mesh_chat_message_received includes pairId + senderPeerId", () => {
    const actions: MeshRootAction[] = [];
    const dispatch = vi.fn((a: MeshRootAction) => void actions.push(a));
    const dc = new FakeOpenChannel();
    attachMeshChatReceiver(dc as unknown as RTCDataChannel, {
      dispatch,
      pairId: "1-2",
      remotePeerId: "peer-b",
      expectedRoomId: "demo",
    });
    dc.emit({
      kind: MESH_CHAT_PAYLOAD_KIND,
      messageId: "m1",
      roomId: "demo",
      senderPeerId: "peer-b",
      text: "hi",
      sentAt: 1,
    });
    const recv = actions.find(
      (a) => a.type === "MESH_EVENT_APPEND" && a.entry.type === "mesh_chat_message_received",
    );
    if (!recv || recv.type !== "MESH_EVENT_APPEND") throw new Error("no recv entry");
    expect(recv.entry.pairId).toBe("1-2");
    expect(recv.entry.peerId).toBe("peer-b");
    expect(recv.entry.detail).toMatchObject({
      transport: "datachannel",
      senderPeerId: "peer-b",
    });
  });

  it("mesh_chat_message_send_skipped includes pairId, remotePeerId, readyState", () => {
    const actions: MeshRootAction[] = [];
    const dispatch = vi.fn((a: MeshRootAction) => void actions.push(a));
    const closed = new FakeOpenChannel();
    closed.readyState = "closed";
    fanOutMeshChat(
      [
        {
          pairId: "1-2",
          remotePeerId: "peer-b",
          dc: closed as unknown as RTCDataChannel,
        },
      ],
      { messageId: "m1", roomId: "demo", senderPeerId: "self", text: "x", sentAt: 1 },
      { dispatch },
    );
    const skip = actions.find(
      (a) => a.type === "MESH_EVENT_APPEND" && a.entry.type === "mesh_chat_message_send_skipped",
    );
    if (!skip || skip.type !== "MESH_EVENT_APPEND") throw new Error("no skip entry");
    expect(skip.entry.pairId).toBe("1-2");
    expect(skip.entry.peerId).toBe("peer-b");
    expect(skip.entry.detail).toMatchObject({
      transport: "datachannel",
      reason: "datachannel_not_open",
      readyState: "closed",
    });
  });

  it("a single send produces exactly one sent-or-skipped entry per pair", () => {
    const actions: MeshRootAction[] = [];
    const dispatch = vi.fn((a: MeshRootAction) => void actions.push(a));
    const open = new FakeOpenChannel();
    const closed = new FakeOpenChannel();
    closed.readyState = "closed";
    fanOutMeshChat(
      [
        { pairId: "1-2", remotePeerId: "peer-b", dc: open as unknown as RTCDataChannel },
        { pairId: "1-3", remotePeerId: "peer-c", dc: closed as unknown as RTCDataChannel },
      ],
      { messageId: "m1", roomId: "demo", senderPeerId: "self", text: "x", sentAt: 1 },
      { dispatch },
    );
    const events = actions.filter(
      (a) =>
        a.type === "MESH_EVENT_APPEND" &&
        (a.entry.type === "mesh_chat_message_sent" ||
          a.entry.type === "mesh_chat_message_send_skipped"),
    );
    // 2 pairs => exactly 2 chat-fanout entries (one per pair, no duplicates).
    expect(events).toHaveLength(2);
  });
});
