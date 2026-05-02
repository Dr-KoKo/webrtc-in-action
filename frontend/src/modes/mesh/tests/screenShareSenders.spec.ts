// T079 — screen-share controller invariants (M10).
//
// Asserts:
//   - start calls getDisplayMedia({ video: true })
//   - start calls replaceTrack(screenTrack) once per active outbound video sender
//     · N=2 ⇒ 1 replaceTrack call
//     · N=3 ⇒ 2 replaceTrack calls
//     · N=4 ⇒ 3 replaceTrack calls
//   - start emits exactly one pair_media_state with screenShare="active"
//   - stop emits exactly one pair_media_state with screenShare="inactive"
//   - stop via app and via screenTrack.onended share the same cleanup path
//   - stop reverts to camera track when camera is on / track available
//   - stop reverts to null when camera is off / track unavailable
//   - sender count remains 2 × (N − 1) across start/stop
//   - the screen-share path NEVER calls addTransceiver / addTrack
//   - picker cancellation does not mutate sender state and does not send
//     a pair_media_state, but does log a "screen share cancelled" entry
//   - stop is idempotent (repeated stop is a no-op)
//
// Verify with:
//   npx vitest run src/modes/mesh/tests/screenShareSenders.spec.ts

import { describe, expect, it, vi, beforeEach } from "vitest";
import { createScreenShareController } from "../webrtc/screenShare";
import { countMeshSenders } from "../webrtc/senders";
import type { MeshPairContext } from "../webrtc/pairContext";
import {
  initialMeshRootState,
  meshRootReducer,
  type MeshRootState,
} from "../state";
import { meshLocalReducer } from "../state/local";

// ---------------------------------------------------------------------
// Test fakes
// ---------------------------------------------------------------------

interface FakeTrack {
  kind: "audio" | "video";
  enabled: boolean;
  readyState: "live" | "ended";
  id: string;
  onended: (() => void) | null;
  stop(): void;
}

function makeFakeTrack(kind: "audio" | "video", id: string): FakeTrack {
  const t: FakeTrack = {
    kind,
    id,
    enabled: true,
    readyState: "live",
    onended: null,
    stop() {
      this.readyState = "ended";
    },
  };
  return t;
}

interface FakeSender {
  track: FakeTrack | null;
  replaceTrackCalls: Array<FakeTrack | null>;
  replaceTrack(track: FakeTrack | null): Promise<void>;
}

function makeFakeSender(initial: FakeTrack | null): FakeSender {
  const s: FakeSender = {
    track: initial,
    replaceTrackCalls: [],
    async replaceTrack(t) {
      this.replaceTrackCalls.push(t);
      this.track = t;
    },
  };
  return s;
}

interface FakePCInstrumentation {
  addTransceiverCalls: number;
  addTrackCalls: number;
}

function makeFakePC(
  audioSender: FakeSender,
  videoSender: FakeSender,
  inst: FakePCInstrumentation,
): { getSenders(): RTCRtpSender[]; addTransceiver: () => never; addTrack: () => never } {
  return {
    getSenders() {
      return [audioSender, videoSender] as unknown as RTCRtpSender[];
    },
    addTransceiver() {
      inst.addTransceiverCalls += 1;
      throw new Error("addTransceiver must NOT be called from screen-share path");
    },
    addTrack() {
      inst.addTrackCalls += 1;
      throw new Error("addTrack must NOT be called from screen-share path");
    },
  };
}

interface FakePairBundle {
  ctx: MeshPairContext;
  audioSender: FakeSender;
  videoSender: FakeSender;
  pcInstrumentation: FakePCInstrumentation;
}

function makeFakePair(pairId: string, remotePeerId: string): FakePairBundle {
  const cameraTrack = makeFakeTrack("video", `cam-${pairId}`);
  const micTrack = makeFakeTrack("audio", `mic-${pairId}`);
  const audioSender = makeFakeSender(micTrack);
  const videoSender = makeFakeSender(cameraTrack);
  const pcInstrumentation: FakePCInstrumentation = {
    addTransceiverCalls: 0,
    addTrackCalls: 0,
  };
  const pc = makeFakePC(audioSender, videoSender, pcInstrumentation);
  const ctx: MeshPairContext = {
    pairId,
    pairEpoch: 1,
    role: "offerer",
    remotePeerId,
    remoteAdmissionIndex: Number(pairId.split("-").pop()) || 1,
    pc: pc as unknown as RTCPeerConnection,
    dc: null,
    senders: [audioSender, videoSender] as unknown as RTCRtpSender[],
    state: "stable",
    iceBuffer: {
      push: () => {},
      drain: async () => {},
      clear: () => {},
      size: () => 0,
    },
    remoteDescriptionApplied: true,
    endOfLocalCandidatesSent: false,
    endOfRemoteCandidatesReceived: false,
    failedReported: false,
    reconnectRequested: false,
  };
  return { ctx, audioSender, videoSender, pcInstrumentation };
}

// Test harness: a tiny store + send capture.
function makeHarness() {
  let state: MeshRootState = {
    ...initialMeshRootState,
    local: meshLocalReducer(initialMeshRootState.local, {
      type: "MESH_JOIN_REQUESTED",
      roomId: "demo",
    }),
  };
  state = {
    ...state,
    local: meshLocalReducer(state.local, {
      type: "MESH_JOIN_ACCEPTED",
      peerId: "00000000-0000-4000-8000-000000000001",
      admissionIndex: 1,
    }),
  };
  state = {
    ...state,
    local: meshLocalReducer(state.local, {
      type: "MESH_MEDIA_ACQUIRE_STARTED",
    }),
  };
  state = {
    ...state,
    local: meshLocalReducer(state.local, { type: "MESH_MEDIA_READY" }),
  };

  const dispatch = vi.fn((a) => {
    state = meshRootReducer(state, a);
  });
  const sentMessages: unknown[] = [];
  const send = vi.fn((m: unknown) => {
    sentMessages.push(m);
  });
  return {
    dispatch,
    send,
    sentMessages,
    getState: () => state,
  };
}

const cameraTrack = makeFakeTrack("video", "local-cam");

beforeEach(() => {
  cameraTrack.readyState = "live";
});

// ---------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------

describe("screen-share start (T075)", () => {
  it("calls getDisplayMedia({ video: true })", async () => {
    const screenTrack = makeFakeTrack("video", "screen-1");
    const screenStream = {
      getVideoTracks: () => [screenTrack],
      getTracks: () => [screenTrack],
    };
    const getDisplayMedia = vi.fn(async () => screenStream as unknown as MediaStream);

    const { dispatch, send } = makeHarness();
    const pair = makeFakePair("1-2", "peer-2");
    const ctrl = createScreenShareController({
      dispatch,
      send,
      getRoomId: () => "demo",
      getPairContexts: () => [pair.ctx],
      getCameraTrack: () => cameraTrack as unknown as MediaStreamTrack,
      getCameraState: () => "on",
      getMicState: () => "on",
      getDisplayMedia,
    });

    await ctrl.start();

    expect(getDisplayMedia).toHaveBeenCalledTimes(1);
    const firstCall = getDisplayMedia.mock.calls[0] as Array<unknown>;
    expect(firstCall[0]).toEqual({ video: true });
  });

  it("calls replaceTrack(screenTrack) once per active outbound video sender — N=2", async () => {
    const screenTrack = makeFakeTrack("video", "screen-1");
    const screenStream = { getVideoTracks: () => [screenTrack], getTracks: () => [screenTrack] };
    const { dispatch, send } = makeHarness();
    const p1 = makeFakePair("1-2", "peer-2");

    const ctrl = createScreenShareController({
      dispatch,
      send,
      getRoomId: () => "demo",
      getPairContexts: () => [p1.ctx],
      getCameraTrack: () => cameraTrack as unknown as MediaStreamTrack,
      getCameraState: () => "on",
      getMicState: () => "on",
      getDisplayMedia: async () => screenStream as unknown as MediaStream,
    });

    await ctrl.start();

    // 1 video sender replaced; audio sender untouched.
    expect(p1.videoSender.replaceTrackCalls).toEqual([screenTrack]);
    expect(p1.audioSender.replaceTrackCalls).toEqual([]);
  });

  it("N=3 ⇒ 2 replaceTrack calls; N=4 ⇒ 3 replaceTrack calls", async () => {
    const cases: Array<{ n: number; pairs: number }> = [
      { n: 3, pairs: 2 },
      { n: 4, pairs: 3 },
    ];
    for (const c of cases) {
      const screenTrack = makeFakeTrack("video", `screen-N${c.n}`);
      const screenStream = { getVideoTracks: () => [screenTrack], getTracks: () => [screenTrack] };
      const { dispatch, send } = makeHarness();
      const pairs = Array.from({ length: c.pairs }, (_, i) =>
        makeFakePair(`1-${i + 2}`, `peer-${i + 2}`),
      );
      const ctrl = createScreenShareController({
        dispatch,
        send,
        getRoomId: () => "demo",
        getPairContexts: () => pairs.map((p) => p.ctx),
        getCameraTrack: () => cameraTrack as unknown as MediaStreamTrack,
        getCameraState: () => "on",
        getMicState: () => "on",
        getDisplayMedia: async () => screenStream as unknown as MediaStream,
      });
      await ctrl.start();
      const totalReplace = pairs.reduce(
        (sum, p) => sum + p.videoSender.replaceTrackCalls.length,
        0,
      );
      expect(totalReplace).toBe(c.pairs);
      // Audio senders untouched.
      for (const p of pairs) {
        expect(p.audioSender.replaceTrackCalls).toEqual([]);
      }
    }
  });

  it("emits exactly one pair_media_state with screenShare=active", async () => {
    const screenTrack = makeFakeTrack("video", "screen-1");
    const screenStream = { getVideoTracks: () => [screenTrack], getTracks: () => [screenTrack] };
    const { dispatch, send, sentMessages } = makeHarness();
    const pairs = Array.from({ length: 3 }, (_, i) =>
      makeFakePair(`1-${i + 2}`, `peer-${i + 2}`),
    );
    const ctrl = createScreenShareController({
      dispatch,
      send,
      getRoomId: () => "demo",
      getPairContexts: () => pairs.map((p) => p.ctx),
      getCameraTrack: () => cameraTrack as unknown as MediaStreamTrack,
      getCameraState: () => "on",
      getMicState: () => "on",
      getDisplayMedia: async () => screenStream as unknown as MediaStream,
    });
    await ctrl.start();
    expect(send).toHaveBeenCalledTimes(1);
    const msg = sentMessages[0] as Record<string, unknown>;
    expect(msg.type).toBe("pair_media_state");
    expect(msg.v).toBe(2);
    expect(msg.roomId).toBe("demo");
    expect(msg.payload).toEqual({
      microphone: "on",
      camera: "on",
      screenShare: "active",
    });
    // Wire-level: no pairId / pairEpoch.
    expect(msg).not.toHaveProperty("pairId");
    expect(msg).not.toHaveProperty("pairEpoch");
    expect(msg.payload as Record<string, unknown>).not.toHaveProperty("pairId");
    expect(msg.payload as Record<string, unknown>).not.toHaveProperty("pairEpoch");
  });

  it("does NOT call addTransceiver or addTrack on any pair's PC", async () => {
    const screenTrack = makeFakeTrack("video", "screen-1");
    const screenStream = { getVideoTracks: () => [screenTrack], getTracks: () => [screenTrack] };
    const { dispatch, send } = makeHarness();
    const pairs = Array.from({ length: 3 }, (_, i) =>
      makeFakePair(`1-${i + 2}`, `peer-${i + 2}`),
    );
    const ctrl = createScreenShareController({
      dispatch,
      send,
      getRoomId: () => "demo",
      getPairContexts: () => pairs.map((p) => p.ctx),
      getCameraTrack: () => cameraTrack as unknown as MediaStreamTrack,
      getCameraState: () => "on",
      getMicState: () => "on",
      getDisplayMedia: async () => screenStream as unknown as MediaStream,
    });
    await ctrl.start();
    for (const p of pairs) {
      expect(p.pcInstrumentation.addTransceiverCalls).toBe(0);
      expect(p.pcInstrumentation.addTrackCalls).toBe(0);
    }
  });

  it("preserves the sender-count invariant — 2 × (N − 1)", async () => {
    const screenTrack = makeFakeTrack("video", "screen-1");
    const screenStream = { getVideoTracks: () => [screenTrack], getTracks: () => [screenTrack] };
    const { dispatch, send } = makeHarness();
    const pairs = Array.from({ length: 3 }, (_, i) =>
      makeFakePair(`1-${i + 2}`, `peer-${i + 2}`),
    );
    const before = countMeshSenders(pairs.map((p) => p.ctx));
    expect(before.outgoingMediaSenders).toBe(2 * 3);

    const ctrl = createScreenShareController({
      dispatch,
      send,
      getRoomId: () => "demo",
      getPairContexts: () => pairs.map((p) => p.ctx),
      getCameraTrack: () => cameraTrack as unknown as MediaStreamTrack,
      getCameraState: () => "on",
      getMicState: () => "on",
      getDisplayMedia: async () => screenStream as unknown as MediaStream,
    });
    await ctrl.start();

    const after = countMeshSenders(pairs.map((p) => p.ctx));
    expect(after.outgoingMediaSenders).toBe(2 * 3);
    expect(after.outgoingAudioSenderCount).toBe(3);
    expect(after.outgoingVideoSenderCount).toBe(3);
  });
});

describe("screen-share stop (T076)", () => {
  it("emits exactly one pair_media_state with screenShare=inactive on app stop", async () => {
    const screenTrack = makeFakeTrack("video", "screen-1");
    const screenStream = { getVideoTracks: () => [screenTrack], getTracks: () => [screenTrack] };
    const { dispatch, send, sentMessages } = makeHarness();
    const pairs = Array.from({ length: 3 }, (_, i) =>
      makeFakePair(`1-${i + 2}`, `peer-${i + 2}`),
    );
    const ctrl = createScreenShareController({
      dispatch,
      send,
      getRoomId: () => "demo",
      getPairContexts: () => pairs.map((p) => p.ctx),
      getCameraTrack: () => cameraTrack as unknown as MediaStreamTrack,
      getCameraState: () => "on",
      getMicState: () => "on",
      getDisplayMedia: async () => screenStream as unknown as MediaStream,
    });
    await ctrl.start();
    send.mockClear();
    sentMessages.length = 0;
    await ctrl.stop("app");

    expect(send).toHaveBeenCalledTimes(1);
    const msg = sentMessages[0] as Record<string, unknown>;
    expect(msg.type).toBe("pair_media_state");
    expect(msg.payload).toEqual({
      microphone: "on",
      camera: "on",
      screenShare: "inactive",
    });
  });

  it("reverts to cameraTrack when camera is on / track available — N=4", async () => {
    const screenTrack = makeFakeTrack("video", "screen-1");
    const screenStream = { getVideoTracks: () => [screenTrack], getTracks: () => [screenTrack] };
    const { dispatch, send } = makeHarness();
    const pairs = Array.from({ length: 3 }, (_, i) =>
      makeFakePair(`1-${i + 2}`, `peer-${i + 2}`),
    );
    const ctrl = createScreenShareController({
      dispatch,
      send,
      getRoomId: () => "demo",
      getPairContexts: () => pairs.map((p) => p.ctx),
      getCameraTrack: () => cameraTrack as unknown as MediaStreamTrack,
      getCameraState: () => "on",
      getMicState: () => "on",
      getDisplayMedia: async () => screenStream as unknown as MediaStream,
    });
    await ctrl.start();
    await ctrl.stop("app");
    for (const p of pairs) {
      expect(p.videoSender.replaceTrackCalls).toEqual([screenTrack, cameraTrack]);
    }
  });

  it("reverts to null when camera is off / track unavailable", async () => {
    const screenTrack = makeFakeTrack("video", "screen-1");
    const screenStream = { getVideoTracks: () => [screenTrack], getTracks: () => [screenTrack] };
    const { dispatch, send } = makeHarness();
    const pairs = [makeFakePair("1-2", "peer-2")];
    const ctrl = createScreenShareController({
      dispatch,
      send,
      getRoomId: () => "demo",
      getPairContexts: () => pairs.map((p) => p.ctx),
      getCameraTrack: () => null,
      getCameraState: () => "off",
      getMicState: () => "on",
      getDisplayMedia: async () => screenStream as unknown as MediaStream,
    });
    await ctrl.start();
    await ctrl.stop("app");
    expect(pairs[0].videoSender.replaceTrackCalls).toEqual([screenTrack, null]);
  });

  it("browser-native onended runs the same cleanup path as app stop", async () => {
    const screenTrack = makeFakeTrack("video", "screen-1");
    const screenStream = { getVideoTracks: () => [screenTrack], getTracks: () => [screenTrack] };
    const { dispatch, send, sentMessages } = makeHarness();
    const pairs = [makeFakePair("1-2", "peer-2")];
    const ctrl = createScreenShareController({
      dispatch,
      send,
      getRoomId: () => "demo",
      getPairContexts: () => pairs.map((p) => p.ctx),
      getCameraTrack: () => cameraTrack as unknown as MediaStreamTrack,
      getCameraState: () => "on",
      getMicState: () => "on",
      getDisplayMedia: async () => screenStream as unknown as MediaStream,
    });
    await ctrl.start();
    send.mockClear();
    sentMessages.length = 0;
    // Simulate browser-native stop.
    expect(typeof screenTrack.onended).toBe("function");
    await screenTrack.onended?.();
    // Allow the async stop() to settle.
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);
    const msg = sentMessages[0] as Record<string, unknown>;
    expect(msg.payload).toMatchObject({ screenShare: "inactive" });
    expect(pairs[0].videoSender.replaceTrackCalls).toEqual([screenTrack, cameraTrack]);
  });

  it("repeated stop is idempotent — does not double-send pair_media_state", async () => {
    const screenTrack = makeFakeTrack("video", "screen-1");
    const screenStream = { getVideoTracks: () => [screenTrack], getTracks: () => [screenTrack] };
    const { dispatch, send } = makeHarness();
    const pairs = [makeFakePair("1-2", "peer-2")];
    const ctrl = createScreenShareController({
      dispatch,
      send,
      getRoomId: () => "demo",
      getPairContexts: () => pairs.map((p) => p.ctx),
      getCameraTrack: () => cameraTrack as unknown as MediaStreamTrack,
      getCameraState: () => "on",
      getMicState: () => "on",
      getDisplayMedia: async () => screenStream as unknown as MediaStream,
    });
    await ctrl.start();
    send.mockClear();
    await ctrl.stop("app");
    await ctrl.stop("app");
    await ctrl.stop("browser");
    expect(send).toHaveBeenCalledTimes(1);
    expect(pairs[0].videoSender.replaceTrackCalls).toEqual([screenTrack, cameraTrack]);
  });

  it("preserves sender count after stop", async () => {
    const screenTrack = makeFakeTrack("video", "screen-1");
    const screenStream = { getVideoTracks: () => [screenTrack], getTracks: () => [screenTrack] };
    const { dispatch, send } = makeHarness();
    const pairs = Array.from({ length: 3 }, (_, i) =>
      makeFakePair(`1-${i + 2}`, `peer-${i + 2}`),
    );
    const ctrl = createScreenShareController({
      dispatch,
      send,
      getRoomId: () => "demo",
      getPairContexts: () => pairs.map((p) => p.ctx),
      getCameraTrack: () => cameraTrack as unknown as MediaStreamTrack,
      getCameraState: () => "on",
      getMicState: () => "on",
      getDisplayMedia: async () => screenStream as unknown as MediaStream,
    });
    await ctrl.start();
    await ctrl.stop("app");
    const counts = countMeshSenders(pairs.map((p) => p.ctx));
    expect(counts.outgoingMediaSenders).toBe(2 * 3);
  });
});

describe("picker cancellation", () => {
  it("does not mutate sender state and does not send pair_media_state", async () => {
    const { dispatch, send, getState } = makeHarness();
    const pair = makeFakePair("1-2", "peer-2");
    const ctrl = createScreenShareController({
      dispatch,
      send,
      getRoomId: () => "demo",
      getPairContexts: () => [pair.ctx],
      getCameraTrack: () => cameraTrack as unknown as MediaStreamTrack,
      getCameraState: () => "on",
      getMicState: () => "on",
      getDisplayMedia: async () => {
        const err = new Error("permission denied");
        err.name = "NotAllowedError";
        throw err;
      },
    });
    await ctrl.start();
    expect(send).not.toHaveBeenCalled();
    expect(pair.videoSender.replaceTrackCalls).toEqual([]);
    expect(getState().localMedia.screenShare).toBe("inactive");
  });

  it("logs a 'screen share cancelled' entry in the event log", async () => {
    const { dispatch, send, getState } = makeHarness();
    const pair = makeFakePair("1-2", "peer-2");
    const ctrl = createScreenShareController({
      dispatch,
      send,
      getRoomId: () => "demo",
      getPairContexts: () => [pair.ctx],
      getCameraTrack: () => cameraTrack as unknown as MediaStreamTrack,
      getCameraState: () => "on",
      getMicState: () => "on",
      getDisplayMedia: async () => {
        const err = new Error("user dismissed picker");
        err.name = "AbortError";
        throw err;
      },
    });
    await ctrl.start();
    const cancelled = getState().eventLog.entries.find(
      (e) =>
        typeof e.summary === "string" &&
        e.summary.includes("screen share cancelled"),
    );
    expect(cancelled).toBeDefined();
    expect(cancelled?.scope).toBe("local");
  });

  it("does not mutate sender state when the picker resolves with an empty stream", async () => {
    const emptyStream = { getVideoTracks: () => [], getTracks: () => [] };
    const { dispatch, send, getState } = makeHarness();
    const pair = makeFakePair("1-2", "peer-2");
    const ctrl = createScreenShareController({
      dispatch,
      send,
      getRoomId: () => "demo",
      getPairContexts: () => [pair.ctx],
      getCameraTrack: () => cameraTrack as unknown as MediaStreamTrack,
      getCameraState: () => "on",
      getMicState: () => "on",
      getDisplayMedia: async () => emptyStream as unknown as MediaStream,
    });
    await ctrl.start();
    expect(send).not.toHaveBeenCalled();
    expect(pair.videoSender.replaceTrackCalls).toEqual([]);
    expect(getState().localMedia.screenShare).toBe("inactive");
  });
});

describe("screen-share source-code constraints (T077 / T078)", () => {
  it("frontend/src/modes/mesh/webrtc/screenShare.ts has no addTransceiver call", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const here = path.resolve(__dirname, "../webrtc/screenShare.ts");
    const src = await fs.readFile(here, "utf8");
    // Match `addTransceiver(` as a function call only — comments and
    // negative assertions are stripped by removing all `//` lines.
    const code = src
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(code).not.toMatch(/addTransceiver\s*\(/);
  });

  it("frontend/src/modes/mesh/webrtc/screenShare.ts has no addTrack call", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const here = path.resolve(__dirname, "../webrtc/screenShare.ts");
    const src = await fs.readFile(here, "utf8");
    const code = src
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    // `pc.addTrack(` is the spelling pairManager uses; we forbid any
    // call form here.
    expect(code).not.toMatch(/\.addTrack\s*\(/);
  });
});

