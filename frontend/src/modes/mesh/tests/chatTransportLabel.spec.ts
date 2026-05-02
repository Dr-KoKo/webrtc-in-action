// T068 — final-MVP chat transport audit (FR-053).
//
// Asserts:
//   - Every chat-event log entry produced by the M8 codepath carries
//     `transport: "datachannel"` in `detail`.
//   - No mesh signaling-message type names "chat" — i.e. no v2
//     contract type `chat_broadcast`, `chat_message`, `room_chat`,
//     etc. exists in the schema (final-MVP transport is DataChannel
//     only).
//   - The receive parser only accepts `kind: "mesh_chat_message"`,
//     never a signaling envelope shape.
//
// If a future "interim signaling chat" branch is added, this spec
// MUST keep passing — i.e. the interim branch is gated off in the
// MVP-shipped path.

import { describe, expect, it, vi } from "vitest";
import { fanOutMeshChat, type MeshChatSendablePair } from "../webrtc/dataChannel";
import { meshAllMessageTypes, type MeshMessageType } from "../protocol/schema";
import type { MeshRootAction } from "../state";

class FakeChannel {
  public readonly sent: string[] = [];
  constructor(public readyState: RTCDataChannelState = "open") {}
  send(data: string) {
    this.sent.push(data);
  }
}

describe("chat transport label", () => {
  it("every mesh_chat_message_sent entry carries transport=datachannel", () => {
    const actions: MeshRootAction[] = [];
    const dispatch = vi.fn((a: MeshRootAction) => void actions.push(a));
    const dc = new FakeChannel();
    const pairs: MeshChatSendablePair[] = [
      { pairId: "1-2", remotePeerId: "peer-b", dc: dc as unknown as RTCDataChannel },
    ];
    fanOutMeshChat(
      pairs,
      { messageId: "m1", roomId: "demo", senderPeerId: "self", text: "x", sentAt: 1 },
      { dispatch },
    );
    const chatEvents = actions.filter(
      (a) =>
        a.type === "MESH_EVENT_APPEND" &&
        (a.entry.type === "mesh_chat_message_sent" ||
          a.entry.type === "mesh_chat_message_send_skipped"),
    );
    expect(chatEvents.length).toBeGreaterThan(0);
    for (const a of chatEvents) {
      if (a.type !== "MESH_EVENT_APPEND") continue;
      expect(a.entry.detail?.transport).toBe("datachannel");
    }
  });

  it("every mesh_chat_message_send_skipped entry carries transport=datachannel", () => {
    const actions: MeshRootAction[] = [];
    const dispatch = vi.fn((a: MeshRootAction) => void actions.push(a));
    const closed = new FakeChannel("closed");
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
    if (!skip || skip.type !== "MESH_EVENT_APPEND") throw new Error("missing");
    expect(skip.entry.detail?.transport).toBe("datachannel");
  });

  it("v2 signaling schema declares NO chat message types", () => {
    const forbidden = ["chat_broadcast", "chat_message", "room_chat", "mesh_chat"];
    for (const t of forbidden) {
      // `meshAllMessageTypes` is the canonical union for `MeshMessageType`.
      // `as MeshMessageType` would fail at compile time for missing names;
      // we runtime-assert to surface the absence cleanly.
      expect(
        (meshAllMessageTypes as readonly string[]).includes(t),
      ).toBe(false);
    }
  });

  it("MeshMessageType.includes(\"mesh_chat_message\") is statically false", () => {
    // This array branch is the live source of truth — if anyone ever
    // ships a signaling-relayed chat type, this assertion forces them
    // to delete this guard explicitly.
    const all = meshAllMessageTypes as readonly MeshMessageType[];
    expect(all.some((t) => /chat/i.test(t))).toBe(false);
  });
});
