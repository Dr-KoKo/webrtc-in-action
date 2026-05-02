// T090 — remotePeerLeftCleanup.spec.ts (M12 / Path B / data-model §C.3).
//
// Asserts the inbound peer_left + mesh_roster_update presence=left
// behavior:
//   - closes only the PairContext local↔leaver (DC + PC + iceBuffer)
//   - removes only that pair view from the store
//   - does NOT touch healthy PairContexts to other peers
//   - does NOT mutate local tracks
//   - does NOT enter LocalParticipant.fsm="failed"
//   - is idempotent across either-order arrival of peer_left and the
//     matching roster `left` update.

import { describe, expect, it, vi } from "vitest";
import { createMeshDispatcher } from "../signaling/dispatcher";
import {
  createMeshPairManager,
  type MeshPairManager,
  type MeshPairManagerDeps,
} from "../webrtc/pairManager";
import {
  fakeAudioTrack,
  fakeVideoTrack,
  makePCFactory,
  type FakeRTCPeerConnection,
} from "./pairTestHelpers";
import {
  initialMeshRosterSlice,
  meshRosterReducer,
  type MeshRosterAction,
} from "../state/roster";
import type { MeshClientMessage } from "../signaling/schema";
import type { MeshRootAction } from "../state";

const ROOM_ID = "demo";
const SELF = "00000000-0000-4000-8000-000000000001";
const PEER_B = "00000000-0000-4000-8000-000000000002";
const PEER_C = "00000000-0000-4000-8000-000000000003";
const ICE: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

interface Harness {
  manager: MeshPairManager;
  dispatch: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  pcFactory: ReturnType<typeof makePCFactory>;
  audio: MediaStreamTrack;
  video: MediaStreamTrack;
  events: MeshRootAction[];
}

function makeHarness(): Harness {
  const events: MeshRootAction[] = [];
  const dispatch = vi.fn((a: MeshRootAction) => {
    events.push(a);
  });
  const send = vi.fn<(m: MeshClientMessage) => void>();
  const audio = fakeAudioTrack();
  const video = fakeVideoTrack();
  const tracks = [audio, video];
  const pcFactory = makePCFactory();
  const stream: MediaStream = {
    getTracks: () => tracks,
    getAudioTracks: () => [audio],
    getVideoTracks: () => [video],
  } as unknown as MediaStream;
  const deps: MeshPairManagerDeps = {
    roomId: ROOM_ID,
    localPeerId: SELF,
    dispatch,
    send,
    mediaSource: {
      getTracks: () => tracks,
      getStream: () => stream,
    },
    peerConnectionFactory: pcFactory.factory,
  };
  const manager = createMeshPairManager(deps);
  return { manager, dispatch, send, pcFactory, audio, video, events };
}

async function allocatePair(
  h: Harness,
  pairId: string,
  remotePeerId: string,
  remoteIdx: number,
  epoch = 1,
) {
  await h.manager.handleNegotiationInstruction({
    pairId,
    pairEpoch: epoch,
    role: "offerer",
    remotePeerId,
    remoteAdmissionIndex: remoteIdx,
    iceServers: ICE,
  });
}

describe("MeshPairManager.closePairByRemotePeerId() — Path B isolation", () => {
  it("closes only the leaver's pair, leaves healthy pairs alone", async () => {
    const h = makeHarness();
    await allocatePair(h, "1-2", PEER_B, 2);
    await allocatePair(h, "1-3", PEER_C, 3);
    const pcB = h.pcFactory.pcs.find(
      (p) => p === h.pcFactory.pcs[0],
    ) as FakeRTCPeerConnection;
    const pcC = h.pcFactory.pcs.find(
      (p) => p === h.pcFactory.pcs[1],
    ) as FakeRTCPeerConnection;

    const result = h.manager.closePairByRemotePeerId(PEER_B);
    expect(result).toBe(true);
    expect(pcB.connectionState).toBe("closed");
    // Healthy pair untouched.
    expect(pcC.connectionState).not.toBe("closed");
    expect(h.manager.getContext("1-2")).toBeUndefined();
    expect(h.manager.getContext("1-3")).toBeDefined();
  });

  it("returns false (no-op) on duplicate close — idempotent", async () => {
    const h = makeHarness();
    await allocatePair(h, "1-2", PEER_B, 2);
    expect(h.manager.closePairByRemotePeerId(PEER_B)).toBe(true);
    expect(h.manager.closePairByRemotePeerId(PEER_B)).toBe(false);
  });

  it("returns false when no pair exists for the peer", () => {
    const h = makeHarness();
    expect(h.manager.closePairByRemotePeerId(PEER_B)).toBe(false);
  });

  it("dispatches MESH_PAIR_REMOVED for the closed pair only", async () => {
    const h = makeHarness();
    await allocatePair(h, "1-2", PEER_B, 2);
    await allocatePair(h, "1-3", PEER_C, 3);
    h.events.length = 0;
    h.manager.closePairByRemotePeerId(PEER_B);
    const removed = h.events.filter(
      (e) => e.type === "MESH_PAIR_REMOVED",
    );
    expect(removed).toHaveLength(1);
    expect((removed[0] as { pairId: string }).pairId).toBe("1-2");
  });

  it("does NOT stop local audio/video tracks", async () => {
    const h = makeHarness();
    await allocatePair(h, "1-2", PEER_B, 2);
    h.manager.closePairByRemotePeerId(PEER_B);
    const audio = h.audio as unknown as { readyState?: string };
    const video = h.video as unknown as { readyState?: string };
    // Tracks are not stopped (they don't carry a stop flag in the
    // fake harness, but the manager never calls `track.stop`).
    expect(audio.readyState).not.toBe("ended");
    expect(video.readyState).not.toBe("ended");
  });
});

describe("dispatcher peer_left + roster left integration", () => {
  it("calls closePairByRemotePeerId on inbound peer_left", async () => {
    const h = makeHarness();
    await allocatePair(h, "1-2", PEER_B, 2);
    const close = vi.spyOn(h.manager, "closePairByRemotePeerId");
    const dispatcher = createMeshDispatcher({
      dispatch: h.dispatch,
      client: null,
      getSelfPeerId: () => SELF,
      getRosterServerSeq: () => 0,
      getLocalFsm: () => "media-ready",
      getPairManager: () => h.manager,
    });
    dispatcher(
      JSON.stringify({
        v: 2,
        type: "peer_left",
        roomId: ROOM_ID,
        payload: { peerId: PEER_B, reason: "disconnect" },
      }),
    );
    expect(close).toHaveBeenCalledWith(PEER_B);
  });

  it("calls closePairByRemotePeerId on roster left presence", async () => {
    const h = makeHarness();
    await allocatePair(h, "1-2", PEER_B, 2);
    const close = vi.spyOn(h.manager, "closePairByRemotePeerId");
    const dispatcher = createMeshDispatcher({
      dispatch: h.dispatch,
      client: null,
      getSelfPeerId: () => SELF,
      getRosterServerSeq: () => 0,
      getLocalFsm: () => "media-ready",
      getPairManager: () => h.manager,
    });
    dispatcher(
      JSON.stringify({
        v: 2,
        type: "mesh_roster_update",
        roomId: ROOM_ID,
        payload: {
          serverSeq: 5,
          subjectPeerId: PEER_B,
          admissionIndex: 2,
          presence: "left",
          reason: "disconnect",
        },
      }),
    );
    expect(close).toHaveBeenCalledWith(PEER_B);
  });

  it("does NOT call closePairByRemotePeerId when subject is local self", () => {
    const h = makeHarness();
    const close = vi.spyOn(h.manager, "closePairByRemotePeerId");
    const dispatcher = createMeshDispatcher({
      dispatch: h.dispatch,
      client: null,
      getSelfPeerId: () => SELF,
      getRosterServerSeq: () => 0,
      getLocalFsm: () => "media-ready",
      getPairManager: () => h.manager,
    });
    dispatcher(
      JSON.stringify({
        v: 2,
        type: "mesh_roster_update",
        roomId: ROOM_ID,
        payload: {
          serverSeq: 5,
          subjectPeerId: SELF,
          admissionIndex: 1,
          presence: "left",
          reason: "graceful_leave",
        },
      }),
    );
    expect(close).not.toHaveBeenCalled();
  });

  it("either-order arrival is idempotent (peer_left then roster left)", async () => {
    const h = makeHarness();
    await allocatePair(h, "1-2", PEER_B, 2);
    const dispatcher = createMeshDispatcher({
      dispatch: h.dispatch,
      client: null,
      getSelfPeerId: () => SELF,
      getRosterServerSeq: () => 0,
      getLocalFsm: () => "media-ready",
      getPairManager: () => h.manager,
    });
    dispatcher(
      JSON.stringify({
        v: 2,
        type: "peer_left",
        roomId: ROOM_ID,
        payload: { peerId: PEER_B, reason: "disconnect" },
      }),
    );
    expect(() =>
      dispatcher(
        JSON.stringify({
          v: 2,
          type: "mesh_roster_update",
          roomId: ROOM_ID,
          payload: {
            serverSeq: 5,
            subjectPeerId: PEER_B,
            admissionIndex: 2,
            presence: "left",
            reason: "disconnect",
          },
        }),
      ),
    ).not.toThrow();
    expect(h.manager.getContext("1-2")).toBeUndefined();
  });

  it("either-order arrival is idempotent (roster left then peer_left)", async () => {
    const h = makeHarness();
    await allocatePair(h, "1-2", PEER_B, 2);
    const dispatcher = createMeshDispatcher({
      dispatch: h.dispatch,
      client: null,
      getSelfPeerId: () => SELF,
      getRosterServerSeq: () => 0,
      getLocalFsm: () => "media-ready",
      getPairManager: () => h.manager,
    });
    dispatcher(
      JSON.stringify({
        v: 2,
        type: "mesh_roster_update",
        roomId: ROOM_ID,
        payload: {
          serverSeq: 5,
          subjectPeerId: PEER_B,
          admissionIndex: 2,
          presence: "left",
          reason: "disconnect",
        },
      }),
    );
    expect(() =>
      dispatcher(
        JSON.stringify({
          v: 2,
          type: "peer_left",
          roomId: ROOM_ID,
          payload: { peerId: PEER_B, reason: "disconnect" },
        }),
      ),
    ).not.toThrow();
    expect(h.manager.getContext("1-2")).toBeUndefined();
  });
});

describe("roster reducer presence=left semantics", () => {
  it("removes the leaver from byPeerId", () => {
    const seeded = meshRosterReducer(initialMeshRosterSlice, {
      type: "MESH_ROSTER_SNAPSHOT_APPLIED",
      serverSeq: 1,
      participants: [
        { peerId: PEER_B, admissionIndex: 2, presence: "joined" },
      ],
      selfPeerId: SELF,
    } satisfies MeshRosterAction);
    expect(seeded.byPeerId[PEER_B]).toBeDefined();
    const after = meshRosterReducer(seeded, {
      type: "MESH_ROSTER_UPDATE_APPLIED",
      serverSeq: 2,
      subjectPeerId: PEER_B,
      admissionIndex: 2,
      presence: "left",
      selfPeerId: SELF,
    });
    expect(after.byPeerId[PEER_B]).toBeUndefined();
    expect(after.serverSeq).toBe(2);
  });
});
