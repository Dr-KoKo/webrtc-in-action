// T089 — leavePath.spec.ts (M12 / Path A / data-model §C.3).
//
// Asserts the local Leave orchestration:
//   - sends `leave_room` exactly once when the WS is open
//   - closes every PairContext PC + DC (pairManager.closeAll)
//   - stops every local audio + video track
//   - stops the active screen track when one is published
//   - closes the WebSocket
//   - resets pairs / roster / chat / localMedia slices
//   - walks LocalParticipant.fsm `* → leaving → left`
//   - is idempotent — second click does NOT double-send leave_room or
//     re-close already-closed handles.

import { describe, expect, it, vi } from "vitest";
import { createMeshLeavePath } from "../webrtc/leavePath";
import {
  initialMeshLocalParticipant,
  meshLocalReducer,
  type MeshLocalParticipant,
  type MeshLocalAction,
} from "../state/local";
import type { MeshPairManager } from "../webrtc/pairManager";
import type { MeshClientMessage } from "../signaling/schema";
import type { MeshRootAction } from "../state";

class FakeTrack {
  stopped = false;
  constructor(public kind: "audio" | "video") {}
  stop(): void {
    this.stopped = true;
  }
}

class FakeStream {
  constructor(private tracks: FakeTrack[]) {}
  getTracks(): FakeTrack[] {
    return this.tracks;
  }
}

interface Harness {
  dispatch: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  closeSocket: ReturnType<typeof vi.fn>;
  publishLocalStream: ReturnType<typeof vi.fn>;
  disposeScreenShare: ReturnType<typeof vi.fn>;
  manager: MeshPairManager;
  audio: FakeTrack;
  video: FakeTrack;
  screen: FakeTrack;
  stream: FakeStream;
  events: MeshRootAction[];
}

function makeHarness(): Harness {
  const events: MeshRootAction[] = [];
  const dispatch = vi.fn((a: MeshRootAction) => {
    events.push(a);
  });
  const send = vi.fn<(m: MeshClientMessage) => void>();
  const closeSocket = vi.fn();
  const publishLocalStream = vi.fn();
  const disposeScreenShare = vi.fn();
  const closeAll = vi.fn();
  const manager: MeshPairManager = {
    handleNegotiationInstruction: vi.fn(),
    handleNewcomerInstructions: vi.fn(),
    handlePairOffer: vi.fn(),
    handlePairAnswer: vi.fn(),
    handlePairIceCandidate: vi.fn(),
    handlePairFailed: vi.fn(),
    handlePairReconnectInstruction: vi.fn(),
    reconnectPair: vi.fn(),
    clearReconnectRequested: vi.fn(),
    getContext: vi.fn(),
    listContexts: vi.fn(() => []),
    listChatPairs: vi.fn(() => []),
    snapshotContext: vi.fn(),
    closeAll,
    closePairByRemotePeerId: vi.fn(() => false),
  } as unknown as MeshPairManager;
  const audio = new FakeTrack("audio");
  const video = new FakeTrack("video");
  const screen = new FakeTrack("video");
  const stream = new FakeStream([audio, video]);
  const _ = createMeshLeavePath; // typecheck import
  void _;
  return {
    dispatch,
    send,
    closeSocket,
    publishLocalStream,
    disposeScreenShare,
    manager,
    audio,
    video,
    screen,
    stream,
    events,
  };
}

function makeLeavePath(h: Harness, opts?: {
  socketOpen?: boolean;
  roomId?: string | null;
  withPairManager?: boolean;
  withScreenTrack?: boolean;
}) {
  return createMeshLeavePath({
    dispatch: h.dispatch,
    send: h.send,
    isSocketOpen: () => opts?.socketOpen ?? true,
    closeSocket: h.closeSocket,
    pairManager:
      opts?.withPairManager === false ? null : h.manager,
    getRoomId: () => opts?.roomId === undefined ? "demo" : opts.roomId,
    getLocalStream: () => h.stream as unknown as MediaStream,
    getActiveScreenTrack: () =>
      opts?.withScreenTrack
        ? (h.screen as unknown as MediaStreamTrack)
        : null,
    publishLocalStream: h.publishLocalStream,
    disposeScreenShare: h.disposeScreenShare,
  });
}

describe("createMeshLeavePath() — Path A graceful Leave", () => {
  it("sends one leave_room over the open socket", () => {
    const h = makeHarness();
    const lp = makeLeavePath(h);
    lp.run();
    const leaveCalls = h.send.mock.calls.filter(
      (c) => (c[0] as MeshClientMessage).type === "leave_room",
    );
    expect(leaveCalls).toHaveLength(1);
    expect(leaveCalls[0]?.[0]).toMatchObject({
      v: 2,
      type: "leave_room",
      roomId: "demo",
      payload: {},
    });
  });

  it("closes every PairContext via pairManager.closeAll()", () => {
    const h = makeHarness();
    const lp = makeLeavePath(h);
    lp.run();
    expect(h.manager.closeAll).toHaveBeenCalledTimes(1);
  });

  it("stops all local audio/video tracks", () => {
    const h = makeHarness();
    const lp = makeLeavePath(h);
    lp.run();
    expect(h.audio.stopped).toBe(true);
    expect(h.video.stopped).toBe(true);
  });

  it("stops the active screen track if one is published", () => {
    const h = makeHarness();
    const lp = makeLeavePath(h, { withScreenTrack: true });
    lp.run();
    expect(h.screen.stopped).toBe(true);
    expect(h.disposeScreenShare).toHaveBeenCalled();
  });

  it("closes the WebSocket exactly once", () => {
    const h = makeHarness();
    const lp = makeLeavePath(h);
    lp.run();
    expect(h.closeSocket).toHaveBeenCalledTimes(1);
  });

  it("publishes a null local stream (clears LocalPreview)", () => {
    const h = makeHarness();
    const lp = makeLeavePath(h);
    lp.run();
    expect(h.publishLocalStream).toHaveBeenCalledWith(null);
  });

  it("dispatches MESH_LEAVE_REQUESTED then MESH_LEAVE_COMPLETED", () => {
    const h = makeHarness();
    const lp = makeLeavePath(h);
    lp.run();
    const types = h.events.map((e) => e.type);
    expect(types).toContain("MESH_LEAVE_REQUESTED");
    expect(types).toContain("MESH_LEAVE_COMPLETED");
    // request precedes completion
    expect(types.indexOf("MESH_LEAVE_REQUESTED")).toBeLessThan(
      types.indexOf("MESH_LEAVE_COMPLETED"),
    );
  });

  it("dispatches every slice reset", () => {
    const h = makeHarness();
    const lp = makeLeavePath(h);
    lp.run();
    const types = h.events.map((e) => e.type);
    expect(types).toContain("MESH_PAIRS_RESET");
    expect(types).toContain("MESH_ROSTER_RESET");
    expect(types).toContain("MESH_CHAT_RESET");
    expect(types).toContain("MESH_LOCAL_MEDIA_RESET");
  });

  it("appends a 'leave requested' event-log entry", () => {
    const h = makeHarness();
    const lp = makeLeavePath(h);
    lp.run();
    const events = h.events.filter(
      (e) => e.type === "MESH_EVENT_APPEND",
    );
    const summaries = events.map(
      (e) => (e as { entry: { summary: string } }).entry.summary,
    );
    expect(summaries).toContain("leave requested");
    expect(summaries).toContain("leave completed");
  });

  it("skips leave_room when WS is not open (signaling-error path)", () => {
    const h = makeHarness();
    const lp = makeLeavePath(h, { socketOpen: false });
    lp.run();
    const leaveCalls = h.send.mock.calls.filter(
      (c) => (c[0] as MeshClientMessage).type === "leave_room",
    );
    expect(leaveCalls).toHaveLength(0);
    // Still closes WS + tears down local state.
    expect(h.closeSocket).toHaveBeenCalled();
    expect(h.audio.stopped).toBe(true);
  });

  it("is idempotent — second run does not double-send leave_room", () => {
    const h = makeHarness();
    const lp = makeLeavePath(h);
    lp.run();
    lp.run();
    const leaveCalls = h.send.mock.calls.filter(
      (c) => (c[0] as MeshClientMessage).type === "leave_room",
    );
    expect(leaveCalls).toHaveLength(1);
    expect(h.manager.closeAll).toHaveBeenCalledTimes(1);
    expect(h.closeSocket).toHaveBeenCalledTimes(1);
    expect(lp.hasRun()).toBe(true);
  });

  it("works without a PairManager (clicked before any pair allocated)", () => {
    const h = makeHarness();
    const lp = makeLeavePath(h, { withPairManager: false });
    expect(() => lp.run()).not.toThrow();
    expect(h.audio.stopped).toBe(true);
    expect(h.closeSocket).toHaveBeenCalled();
  });
});

describe("meshLocalReducer leave transitions", () => {
  function joined(): MeshLocalParticipant {
    let s = initialMeshLocalParticipant;
    s = meshLocalReducer(s, {
      type: "MESH_JOIN_REQUESTED",
      roomId: "demo",
    } satisfies MeshLocalAction);
    s = meshLocalReducer(s, {
      type: "MESH_JOIN_ACCEPTED",
      peerId: "00000000-0000-4000-8000-000000000001",
      admissionIndex: 1,
    });
    s = meshLocalReducer(s, { type: "MESH_MEDIA_ACQUIRE_STARTED" });
    s = meshLocalReducer(s, { type: "MESH_MEDIA_READY" });
    return s;
  }

  it("walks media-ready → leaving → left", () => {
    let s = joined();
    s = meshLocalReducer(s, { type: "MESH_LEAVE_REQUESTED" });
    expect(s.fsm).toBe("leaving");
    s = meshLocalReducer(s, { type: "MESH_LEAVE_COMPLETED" });
    expect(s.fsm).toBe("left");
  });

  it("MESH_LEAVE_REQUESTED is idempotent (second dispatch in `leaving` is a no-op)", () => {
    let s = joined();
    s = meshLocalReducer(s, { type: "MESH_LEAVE_REQUESTED" });
    const firstLeaving = s;
    s = meshLocalReducer(s, { type: "MESH_LEAVE_REQUESTED" });
    expect(s).toBe(firstLeaving);
  });

  it("MESH_LEAVE_REQUESTED in idle is a no-op (nothing to leave)", () => {
    const s = meshLocalReducer(initialMeshLocalParticipant, {
      type: "MESH_LEAVE_REQUESTED",
    });
    expect(s).toBe(initialMeshLocalParticipant);
  });

  it("MESH_LEAVE_COMPLETED outside `leaving` is dropped", () => {
    const s = meshLocalReducer(initialMeshLocalParticipant, {
      type: "MESH_LEAVE_COMPLETED",
    });
    expect(s).toBe(initialMeshLocalParticipant);
  });

  it("Leave from signaling-error is allowed", () => {
    let s = joined();
    s = meshLocalReducer(s, {
      type: "MESH_TRANSPORT_CHANGED",
      transport: "closed",
    });
    expect(s.fsm).toBe("signaling-error");
    s = meshLocalReducer(s, { type: "MESH_LEAVE_REQUESTED" });
    expect(s.fsm).toBe("leaving");
  });
});
