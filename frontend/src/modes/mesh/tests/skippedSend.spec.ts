// T066 — skipped-peer log entry on closed DataChannel (EC-008, FR-052).
//
// Asserts:
//   - Closed / connecting / closing / null dc all skip the send.
//   - The skip surfaces exactly one event-log entry per skipped pair,
//     carrying `pairId`, `remotePeerId`, `reason`, and `readyState`.
//   - Open peers in the same fan-out still receive normally.
//   - The fan-out summary returns delivered/attempted correctly.

import { describe, expect, it, vi } from "vitest";
import { fanOutMeshChat, type MeshChatSendablePair } from "../webrtc/dataChannel";
import type { MeshRootAction } from "../state";

class FakeChannel {
  public readonly sent: string[] = [];
  constructor(public readyState: RTCDataChannelState) {}
  send(data: string) {
    this.sent.push(data);
  }
}

function makeDispatch() {
  const actions: MeshRootAction[] = [];
  return { actions, dispatch: vi.fn((a: MeshRootAction) => void actions.push(a)) };
}

const ROOM = "demo";
const SELF = "9";

function pair(
  pairId: string,
  remotePeerId: string,
  state: RTCDataChannelState | "null",
): MeshChatSendablePair {
  if (state === "null") {
    return { pairId, remotePeerId, dc: null };
  }
  return {
    pairId,
    remotePeerId,
    dc: new FakeChannel(state) as unknown as RTCDataChannel,
  };
}

describe("skipped send on non-open DataChannel", () => {
  it("skips closed dc; logs reason=datachannel_not_open with readyState", () => {
    const { actions, dispatch } = makeDispatch();
    const result = fanOutMeshChat(
      [pair("1-2", "peer-b", "closed")],
      { messageId: "m1", roomId: ROOM, senderPeerId: SELF, text: "x", sentAt: 1 },
      { dispatch },
    );
    expect(result.skipped).toHaveLength(1);
    expect(result.succeeded).toBe(0);
    const skipEvent = actions.find(
      (a) => a.type === "MESH_EVENT_APPEND" && a.entry.type === "mesh_chat_message_send_skipped",
    );
    if (!skipEvent || skipEvent.type !== "MESH_EVENT_APPEND") throw new Error("missing");
    expect(skipEvent.entry.pairId).toBe("1-2");
    expect(skipEvent.entry.peerId).toBe("peer-b");
    expect(skipEvent.entry.detail).toMatchObject({
      transport: "datachannel",
      reason: "datachannel_not_open",
      readyState: "closed",
    });
  });

  it("skips connecting dc", () => {
    const { dispatch } = makeDispatch();
    const result = fanOutMeshChat(
      [pair("1-2", "peer-b", "connecting")],
      { messageId: "m1", roomId: ROOM, senderPeerId: SELF, text: "x", sentAt: 1 },
      { dispatch },
    );
    expect(result.skipped[0].readyState).toBe("connecting");
  });

  it("skips closing dc", () => {
    const { dispatch } = makeDispatch();
    const result = fanOutMeshChat(
      [pair("1-2", "peer-b", "closing")],
      { messageId: "m1", roomId: ROOM, senderPeerId: SELF, text: "x", sentAt: 1 },
      { dispatch },
    );
    expect(result.skipped[0].readyState).toBe("closing");
  });

  it("skips null dc with readyState=pending", () => {
    const { dispatch } = makeDispatch();
    const result = fanOutMeshChat(
      [pair("1-2", "peer-b", "null")],
      { messageId: "m1", roomId: ROOM, senderPeerId: SELF, text: "x", sentAt: 1 },
      { dispatch },
    );
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].readyState).toBe("pending");
  });

  it("emits exactly one skipped event per skipped pair", () => {
    const { actions, dispatch } = makeDispatch();
    fanOutMeshChat(
      [
        pair("1-2", "peer-b", "closed"),
        pair("1-3", "peer-c", "connecting"),
      ],
      { messageId: "m1", roomId: ROOM, senderPeerId: SELF, text: "x", sentAt: 1 },
      { dispatch },
    );
    const skips = actions.filter(
      (a) => a.type === "MESH_EVENT_APPEND" && a.entry.type === "mesh_chat_message_send_skipped",
    );
    expect(skips).toHaveLength(2);
  });

  it("open peers still receive when one of three is closed (2/3 delivered)", () => {
    const { actions, dispatch } = makeDispatch();
    const dcOpen1 = new FakeChannel("open");
    const dcOpen2 = new FakeChannel("open");
    const result = fanOutMeshChat(
      [
        { pairId: "1-2", remotePeerId: "peer-b", dc: dcOpen1 as unknown as RTCDataChannel },
        pair("1-3", "peer-c", "closed"),
        { pairId: "1-4", remotePeerId: "peer-d", dc: dcOpen2 as unknown as RTCDataChannel },
      ],
      { messageId: "m1", roomId: ROOM, senderPeerId: SELF, text: "x", sentAt: 1 },
      { dispatch },
    );
    expect(dcOpen1.sent).toHaveLength(1);
    expect(dcOpen2.sent).toHaveLength(1);
    expect(result.succeeded).toBe(2);
    expect(result.attempted).toBe(3);
    expect(result.skipped).toHaveLength(1);
    const sentEvents = actions.filter(
      (a) => a.type === "MESH_EVENT_APPEND" && a.entry.type === "mesh_chat_message_sent",
    );
    expect(sentEvents).toHaveLength(2);
  });
});
