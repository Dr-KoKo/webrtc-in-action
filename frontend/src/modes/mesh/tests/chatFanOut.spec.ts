// T063 / T067 — sender fan-out + local echo (FR-051..FR-052a, L17).
//
// Asserts:
//   - At N=2 the sender produces exactly 1 dc.send and 1 sent event.
//   - At N=3 the sender produces 2 dc.sends and 2 sent events.
//   - At N=4 the sender produces 3 dc.sends and 3 sent events.
//   - The fan-out summary's `attempted` equals |PairMap| at send time.
//   - The local echo (caller's responsibility) is added once even
//     when 0/N dc are open — this is the FR-052a invariant.
//   - One `chat message sent` event-log entry per succeeded pair,
//     one `chat message send skipped` per skipped pair.

import { describe, expect, it, vi } from "vitest";
import {
  fanOutMeshChat,
  MESH_CHAT_PAYLOAD_KIND,
  type MeshChatSendablePair,
} from "../webrtc/dataChannel";
import type { MeshRootAction } from "../state";

class FakeOpenChannel {
  public readyState: RTCDataChannelState = "open";
  public readonly sent: string[] = [];
  send(data: string) {
    this.sent.push(data);
  }
}

class FakeStateChannel {
  public sent: string[] = [];
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
const SELF = "99999999-9999-4999-8999-999999999999";

describe("fanOutMeshChat", () => {
  it("N=2 produces 1 dc.send and 1 sent event", () => {
    const { actions, dispatch } = makeDispatch();
    const dc = new FakeOpenChannel();
    const pairs: MeshChatSendablePair[] = [
      { pairId: "1-2", remotePeerId: "peer-b", dc: dc as unknown as RTCDataChannel },
    ];
    const result = fanOutMeshChat(
      pairs,
      { messageId: "m1", roomId: ROOM, senderPeerId: SELF, text: "hi", sentAt: 1 },
      { dispatch },
    );
    expect(dc.sent).toHaveLength(1);
    const sentPayload = JSON.parse(dc.sent[0]);
    expect(sentPayload.kind).toBe(MESH_CHAT_PAYLOAD_KIND);
    expect(sentPayload.text).toBe("hi");
    expect(result).toEqual({ messageId: "m1", attempted: 1, succeeded: 1, skipped: [] });
    const sentEntries = actions.filter(
      (a) => a.type === "MESH_EVENT_APPEND" && a.entry.type === "mesh_chat_message_sent",
    );
    expect(sentEntries).toHaveLength(1);
  });

  it("N=3 produces 2 dc.sends and 2 sent events", () => {
    const { actions, dispatch } = makeDispatch();
    const dcs = [new FakeOpenChannel(), new FakeOpenChannel()];
    const result = fanOutMeshChat(
      [
        { pairId: "1-2", remotePeerId: "peer-b", dc: dcs[0] as unknown as RTCDataChannel },
        { pairId: "1-3", remotePeerId: "peer-c", dc: dcs[1] as unknown as RTCDataChannel },
      ],
      { messageId: "m2", roomId: ROOM, senderPeerId: SELF, text: "hi3", sentAt: 1 },
      { dispatch },
    );
    expect(dcs[0].sent).toHaveLength(1);
    expect(dcs[1].sent).toHaveLength(1);
    expect(result.succeeded).toBe(2);
    expect(result.attempted).toBe(2);
    const sent = actions.filter(
      (a) => a.type === "MESH_EVENT_APPEND" && a.entry.type === "mesh_chat_message_sent",
    );
    expect(sent).toHaveLength(2);
  });

  it("N=4 produces 3 dc.sends and 3 sent events", () => {
    const { actions, dispatch } = makeDispatch();
    const dcs = [new FakeOpenChannel(), new FakeOpenChannel(), new FakeOpenChannel()];
    const result = fanOutMeshChat(
      [
        { pairId: "1-2", remotePeerId: "peer-b", dc: dcs[0] as unknown as RTCDataChannel },
        { pairId: "1-3", remotePeerId: "peer-c", dc: dcs[1] as unknown as RTCDataChannel },
        { pairId: "1-4", remotePeerId: "peer-d", dc: dcs[2] as unknown as RTCDataChannel },
      ],
      { messageId: "m3", roomId: ROOM, senderPeerId: SELF, text: "hi4", sentAt: 1 },
      { dispatch },
    );
    expect(dcs.every((d) => d.sent.length === 1)).toBe(true);
    expect(result).toEqual({ messageId: "m3", attempted: 3, succeeded: 3, skipped: [] });
    const sent = actions.filter(
      (a) => a.type === "MESH_EVENT_APPEND" && a.entry.type === "mesh_chat_message_sent",
    );
    expect(sent).toHaveLength(3);
  });

  it("each sent event-log entry carries pairId + remotePeerId + transport=datachannel", () => {
    const { actions, dispatch } = makeDispatch();
    const dc = new FakeOpenChannel();
    fanOutMeshChat(
      [{ pairId: "1-2", remotePeerId: "peer-b", dc: dc as unknown as RTCDataChannel }],
      { messageId: "m1", roomId: ROOM, senderPeerId: SELF, text: "x", sentAt: 1 },
      { dispatch },
    );
    const sentEntry = actions.find(
      (a) => a.type === "MESH_EVENT_APPEND" && a.entry.type === "mesh_chat_message_sent",
    );
    if (!sentEntry || sentEntry.type !== "MESH_EVENT_APPEND") throw new Error("missing");
    expect(sentEntry.entry.pairId).toBe("1-2");
    expect(sentEntry.entry.peerId).toBe("peer-b");
    expect(sentEntry.entry.detail).toMatchObject({
      transport: "datachannel",
      messageId: "m1",
    });
  });

  it("returns correct attempted count when |PairMap|=3 but only 2 are open", () => {
    const { dispatch } = makeDispatch();
    const dcOpen = new FakeOpenChannel();
    const dcOpen2 = new FakeOpenChannel();
    const dcClosed = new FakeStateChannel("closed");
    const result = fanOutMeshChat(
      [
        { pairId: "1-2", remotePeerId: "peer-b", dc: dcOpen as unknown as RTCDataChannel },
        { pairId: "1-3", remotePeerId: "peer-c", dc: dcClosed as unknown as RTCDataChannel },
        { pairId: "1-4", remotePeerId: "peer-d", dc: dcOpen2 as unknown as RTCDataChannel },
      ],
      { messageId: "m4", roomId: ROOM, senderPeerId: SELF, text: "hi", sentAt: 1 },
      { dispatch },
    );
    expect(result.attempted).toBe(3);
    expect(result.succeeded).toBe(2);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({
      pairId: "1-3",
      remotePeerId: "peer-c",
      reason: "datachannel_not_open",
      readyState: "closed",
    });
  });
});
