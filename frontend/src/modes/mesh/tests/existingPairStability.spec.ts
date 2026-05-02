// T053 — existingPairStability.spec.ts. Covers T051 / FR-022a / L18:
// when a newcomer's pair_negotiation_instruction arrives, only the
// new PairContext is allocated. Existing entries (pc, dc, senders,
// state, pairEpoch) MUST remain byte-identical references.

import { describe, expect, it, vi } from "vitest";
import {
  createMeshPairManager,
  type MeshPairManagerDeps,
} from "../webrtc/pairManager";
import {
  fakeAudioTrack,
  fakeMediaSource,
  fakeVideoTrack,
  makePCFactory,
} from "./pairTestHelpers";
import type { MeshClientMessage } from "../protocol/schema";

const ROOM_ID = "demo";
const SELF_PEER = "00000000-0000-4000-8000-000000000001"; // self admissionIndex=1
const PEER_B = "00000000-0000-4000-8000-000000000002";
const PEER_C = "00000000-0000-4000-8000-000000000003";
const PEER_K = "00000000-0000-4000-8000-000000000004";
const ICE: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

function makeManager() {
  const dispatch = vi.fn();
  const send = vi.fn<(m: MeshClientMessage) => void>();
  const tracks = [fakeAudioTrack(), fakeVideoTrack()];
  const pcFactory = makePCFactory();
  const deps: MeshPairManagerDeps = {
    roomId: ROOM_ID,
    localPeerId: SELF_PEER,
    dispatch,
    send,
    mediaSource: fakeMediaSource(tracks),
    peerConnectionFactory: pcFactory.factory,
  };
  return { manager: createMeshPairManager(deps), pcFactory, send, dispatch };
}

describe("MeshPairManager — existing-pair stability (T051 / L18)", () => {
  it("newcomer instruction does NOT mutate existing PairContext entries", async () => {
    const { manager, pcFactory, send } = makeManager();

    // Setup: self (idx=1) has pairs 1-2 and 1-3 already established.
    await manager.handleNewcomerInstructions([
      {
        pairId: "1-2",
        pairEpoch: 1,
        role: "offerer",
        remotePeerId: PEER_B,
        remoteAdmissionIndex: 2,
        iceServers: ICE,
      },
      {
        pairId: "1-3",
        pairEpoch: 1,
        role: "offerer",
        remotePeerId: PEER_C,
        remoteAdmissionIndex: 3,
        iceServers: ICE,
      },
    ]);

    const pre12 = manager.snapshotContext("1-2");
    const pre13 = manager.snapshotContext("1-3");
    expect(pre12).not.toBeNull();
    expect(pre13).not.toBeNull();
    const sendCallsBefore = send.mock.calls.length;
    const pcCountBefore = pcFactory.pcs.length;

    // Newcomer K (idx=4) joins → only the 1-4 pair is allocated.
    const created = await manager.handleNewcomerInstructions([
      {
        pairId: "1-4",
        pairEpoch: 1,
        role: "offerer",
        remotePeerId: PEER_K,
        remoteAdmissionIndex: 4,
        iceServers: ICE,
      },
    ]);
    expect(created).toHaveLength(1);
    expect(created[0]!.pairId).toBe("1-4");

    // Existing entries unchanged: same pc, dc, senders, state, epoch.
    const post12 = manager.snapshotContext("1-2");
    const post13 = manager.snapshotContext("1-3");
    expect(post12?.pc).toBe(pre12?.pc);
    expect(post12?.dc).toBe(pre12?.dc);
    expect(post12?.senders).toBe(pre12?.senders);
    expect(post12?.state).toBe(pre12?.state);
    expect(post12?.pairEpoch).toBe(pre12?.pairEpoch);

    expect(post13?.pc).toBe(pre13?.pc);
    expect(post13?.dc).toBe(pre13?.dc);
    expect(post13?.senders).toBe(pre13?.senders);
    expect(post13?.state).toBe(pre13?.state);
    expect(post13?.pairEpoch).toBe(pre13?.pairEpoch);

    // Exactly one new pc allocated (no second PC for existing pairs).
    expect(pcFactory.pcs.length).toBe(pcCountBefore + 1);
    // Exactly one new pair_offer was emitted (for 1-4).
    const newSends = send.mock.calls.slice(sendCallsBefore).map((c) => c[0]);
    expect(newSends.filter((m) => m.type === "pair_offer")).toHaveLength(1);
  });

  it("re-applying the same newcomer instruction is a no-op (idempotent)", async () => {
    const { manager, pcFactory, send } = makeManager();

    await manager.handleNewcomerInstructions([
      {
        pairId: "1-2",
        pairEpoch: 1,
        role: "offerer",
        remotePeerId: PEER_B,
        remoteAdmissionIndex: 2,
        iceServers: ICE,
      },
    ]);
    const pcCount = pcFactory.pcs.length;
    const sendCount = send.mock.calls.length;

    await manager.handleNewcomerInstructions([
      {
        pairId: "1-2",
        pairEpoch: 1,
        role: "offerer",
        remotePeerId: PEER_B,
        remoteAdmissionIndex: 2,
        iceServers: ICE,
      },
    ]);
    expect(pcFactory.pcs.length).toBe(pcCount);
    expect(send.mock.calls.length).toBe(sendCount);
  });
});
