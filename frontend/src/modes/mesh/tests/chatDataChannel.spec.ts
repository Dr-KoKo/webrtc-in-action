// T062 — DataChannel chat receive plumbing.
//
// Asserts:
//   - `attachMeshChatReceiver` registers `dc.onmessage` exactly once
//     per RTCDataChannel reference (idempotent on double-attach).
//   - A valid inbound payload dispatches one `MESH_CHAT_INBOUND_APPENDED`
//     and one pair-scoped `mesh_chat_message_received` event with
//     `transport: "datachannel"`.
//   - Malformed payloads (bad JSON, wrong kind, missing fields, wrong
//     roomId) trigger a `mesh_chat_message_received_invalid` event AND
//     do NOT mutate the chat slice.
//   - Registering the same dc twice on the same handler does not
//     produce duplicate appends.

import { describe, expect, it, vi } from "vitest";
import {
  attachMeshChatReceiver,
  MESH_CHAT_PAYLOAD_KIND,
} from "../webrtc/dataChannel";
import type { MeshRootAction } from "../state";

const PAIR_ID = "1-2";
const REMOTE = "11111111-1111-4111-8111-111111111111";
const ROOM = "demo";

class FakeChannel {
  public readyState: RTCDataChannelState = "open";
  public onmessage: ((e: MessageEvent) => void) | null = null;
  // RTCDataChannel emits via `addEventListener` AND via the `onmessage`
  // setter; M8 uses the setter so we only need to support that path.
  public emit(data: unknown) {
    const evt = { data: typeof data === "string" ? data : JSON.stringify(data) } as MessageEvent;
    this.onmessage?.(evt);
  }
}

function setupDispatch() {
  const actions: MeshRootAction[] = [];
  const dispatch = vi.fn((a: MeshRootAction) => {
    actions.push(a);
  });
  return { actions, dispatch };
}

describe("attachMeshChatReceiver", () => {
  it("dispatches one inbound + one received event for a valid payload", () => {
    const { actions, dispatch } = setupDispatch();
    const dc = new FakeChannel();
    attachMeshChatReceiver(dc as unknown as RTCDataChannel, {
      dispatch,
      pairId: PAIR_ID,
      remotePeerId: REMOTE,
      expectedRoomId: ROOM,
      now: () => 5000,
    });
    dc.emit({
      kind: MESH_CHAT_PAYLOAD_KIND,
      messageId: "wm-1",
      roomId: ROOM,
      senderPeerId: REMOTE,
      text: "hello",
      sentAt: 4000,
    });
    const inbound = actions.filter((a) => a.type === "MESH_CHAT_INBOUND_APPENDED");
    const eventLog = actions.filter(
      (a) => a.type === "MESH_EVENT_APPEND" && a.entry.type === "mesh_chat_message_received",
    );
    expect(inbound).toHaveLength(1);
    expect(eventLog).toHaveLength(1);
    if (inbound[0].type !== "MESH_CHAT_INBOUND_APPENDED") throw new Error("type");
    expect(inbound[0].message).toMatchObject({
      id: "wm-1",
      authorPeerId: REMOTE,
      text: "hello",
      sentAt: 4000,
      receivedAt: 5000,
    });
    if (eventLog[0].type !== "MESH_EVENT_APPEND") throw new Error("type");
    expect(eventLog[0].entry.scope).toBe("pair");
    expect(eventLog[0].entry.pairId).toBe(PAIR_ID);
    expect(eventLog[0].entry.peerId).toBe(REMOTE);
    expect(eventLog[0].entry.detail).toMatchObject({
      transport: "datachannel",
      messageId: "wm-1",
      senderPeerId: REMOTE,
    });
  });

  it("is idempotent on double registration for the same dc instance", () => {
    const { actions, dispatch } = setupDispatch();
    const dc = new FakeChannel();
    attachMeshChatReceiver(dc as unknown as RTCDataChannel, {
      dispatch,
      pairId: PAIR_ID,
      remotePeerId: REMOTE,
      expectedRoomId: ROOM,
    });
    // Double attach — should not double-handle.
    attachMeshChatReceiver(dc as unknown as RTCDataChannel, {
      dispatch,
      pairId: PAIR_ID,
      remotePeerId: REMOTE,
      expectedRoomId: ROOM,
    });
    dc.emit({
      kind: MESH_CHAT_PAYLOAD_KIND,
      messageId: "wm-2",
      roomId: ROOM,
      senderPeerId: REMOTE,
      text: "hi",
      sentAt: 1,
    });
    const inbound = actions.filter((a) => a.type === "MESH_CHAT_INBOUND_APPENDED");
    expect(inbound).toHaveLength(1);
  });

  it("rejects malformed JSON without throwing or mutating chat state", () => {
    const { actions, dispatch } = setupDispatch();
    const dc = new FakeChannel();
    attachMeshChatReceiver(dc as unknown as RTCDataChannel, {
      dispatch,
      pairId: PAIR_ID,
      remotePeerId: REMOTE,
      expectedRoomId: ROOM,
    });
    // Bypass `emit`'s JSON helper — feed raw, non-JSON string.
    dc.onmessage?.({ data: "{not-json" } as MessageEvent);
    const inbound = actions.filter((a) => a.type === "MESH_CHAT_INBOUND_APPENDED");
    const invalid = actions.filter(
      (a) =>
        a.type === "MESH_EVENT_APPEND" && a.entry.type === "mesh_chat_message_received_invalid",
    );
    expect(inbound).toHaveLength(0);
    expect(invalid).toHaveLength(1);
  });

  it("rejects wrong-kind payload", () => {
    const { actions, dispatch } = setupDispatch();
    const dc = new FakeChannel();
    attachMeshChatReceiver(dc as unknown as RTCDataChannel, {
      dispatch,
      pairId: PAIR_ID,
      remotePeerId: REMOTE,
      expectedRoomId: ROOM,
    });
    dc.emit({ kind: "other_kind", text: "hi" });
    expect(
      actions.filter((a) => a.type === "MESH_CHAT_INBOUND_APPENDED"),
    ).toHaveLength(0);
    expect(
      actions.filter(
        (a) => a.type === "MESH_EVENT_APPEND" && a.entry.type === "mesh_chat_message_received_invalid",
      ),
    ).toHaveLength(1);
  });

  it("rejects payload with mismatched roomId", () => {
    const { actions, dispatch } = setupDispatch();
    const dc = new FakeChannel();
    attachMeshChatReceiver(dc as unknown as RTCDataChannel, {
      dispatch,
      pairId: PAIR_ID,
      remotePeerId: REMOTE,
      expectedRoomId: ROOM,
    });
    dc.emit({
      kind: MESH_CHAT_PAYLOAD_KIND,
      messageId: "wm-3",
      roomId: "other-room",
      senderPeerId: REMOTE,
      text: "x",
      sentAt: 1,
    });
    expect(
      actions.filter((a) => a.type === "MESH_CHAT_INBOUND_APPENDED"),
    ).toHaveLength(0);
    expect(
      actions.filter(
        (a) => a.type === "MESH_EVENT_APPEND" && a.entry.type === "mesh_chat_message_received_invalid",
      ),
    ).toHaveLength(1);
  });

  it("rejects payload missing required fields", () => {
    const { actions, dispatch } = setupDispatch();
    const dc = new FakeChannel();
    attachMeshChatReceiver(dc as unknown as RTCDataChannel, {
      dispatch,
      pairId: PAIR_ID,
      remotePeerId: REMOTE,
      expectedRoomId: ROOM,
    });
    dc.emit({ kind: MESH_CHAT_PAYLOAD_KIND, roomId: ROOM });
    expect(
      actions.filter((a) => a.type === "MESH_CHAT_INBOUND_APPENDED"),
    ).toHaveLength(0);
    expect(
      actions.filter(
        (a) =>
          a.type === "MESH_EVENT_APPEND" &&
          a.entry.type === "mesh_chat_message_received_invalid",
      ),
    ).toHaveLength(1);
  });
});
