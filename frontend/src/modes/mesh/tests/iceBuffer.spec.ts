// T054 — iceBuffer.spec.ts. Covers the per-pair ICE buffer module
// (`webrtc/iceBuffer.ts`) and its integration with the PairManager:
//   - candidates arriving before setRemoteDescription are buffered
//   - flush after SRD applies them in order
//   - candidate:null is preserved as end-of-candidates
//   - stale pairEpoch candidates are dropped (no addIceCandidate, no
//     mutation of the active PairContext)
//   - wrong pairId candidate is ignored without touching another pair

import { describe, expect, it, vi } from "vitest";
import { createIceBuffer } from "../webrtc/iceBuffer";
import {
  createMeshPairManager,
  type MeshPairManagerDeps,
} from "../webrtc/pairManager";
import {
  fakeAudioTrack,
  fakeMediaSource,
  fakeVideoTrack,
  makePCFactory,
  type FakeRTCPeerConnection,
} from "./pairTestHelpers";
import type { MeshClientMessage } from "../signaling/schema";

const ROOM_ID = "demo";
const SELF_PEER = "00000000-0000-4000-8000-000000000001";
const PEER_B = "00000000-0000-4000-8000-000000000002";
const PEER_C = "00000000-0000-4000-8000-000000000003";
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

function eventEntries(dispatch: ReturnType<typeof vi.fn>) {
  return dispatch.mock.calls
    .map((c) => c[0])
    .filter((a) => a?.type === "MESH_EVENT_APPEND")
    .map((a) => a.entry);
}

function entriesOfKind(dispatch: ReturnType<typeof vi.fn>, kind: string) {
  return eventEntries(dispatch).filter((e) => e.detail?.kind === kind);
}

describe("IceBuffer (T054 — pure module)", () => {
  it("preserves push order including candidate:null sentinel", async () => {
    const buf = createIceBuffer();
    buf.push({ candidate: "c1" });
    buf.push({ candidate: "c2" });
    buf.push(null);
    buf.push({ candidate: "c3" });
    const seen: Array<RTCIceCandidateInit | null> = [];
    await buf.drain((c) => {
      seen.push(c);
    });
    expect(seen.map((c) => (c === null ? "<eoc>" : c.candidate))).toEqual([
      "c1",
      "c2",
      "<eoc>",
      "c3",
    ]);
    expect(buf.size()).toBe(0);
  });

  it("clear empties the buffer", () => {
    const buf = createIceBuffer();
    buf.push({ candidate: "c1" });
    buf.push({ candidate: "c2" });
    expect(buf.size()).toBe(2);
    buf.clear();
    expect(buf.size()).toBe(0);
  });
});

describe("PairManager × IceBuffer integration (T054 / T056)", () => {
  it("buffers inbound ICE candidates that arrive before setRemoteDescription", async () => {
    const { manager, dispatch, pcFactory } = makeManager();
    await manager.handleNegotiationInstruction({
      pairId: "1-2",
      pairEpoch: 1,
      role: "answerer",
      remotePeerId: PEER_B,
      remoteAdmissionIndex: 2,
      iceServers: ICE,
    });
    // Arrive ICE before the offer (and therefore before SRD).
    await manager.handlePairIceCandidate({
      pairId: "1-2",
      pairEpoch: 1,
      candidate: { candidate: "c1", sdpMid: "0", sdpMLineIndex: 0 },
    });
    await manager.handlePairIceCandidate({
      pairId: "1-2",
      pairEpoch: 1,
      candidate: null,
    });
    const pc = pcFactory.pcs[0]! as FakeRTCPeerConnection;
    expect(pc.addedIceCandidates).toHaveLength(0);
    expect(entriesOfKind(dispatch, "ice_candidate_buffered")).toHaveLength(2);
  });

  it("flushes buffered ICE in arrival order after setRemoteDescription", async () => {
    const { manager, dispatch, pcFactory } = makeManager();
    await manager.handleNegotiationInstruction({
      pairId: "1-2",
      pairEpoch: 1,
      role: "answerer",
      remotePeerId: PEER_B,
      remoteAdmissionIndex: 2,
      iceServers: ICE,
    });
    await manager.handlePairIceCandidate({
      pairId: "1-2",
      pairEpoch: 1,
      candidate: { candidate: "c1", sdpMid: "0" },
    });
    await manager.handlePairIceCandidate({
      pairId: "1-2",
      pairEpoch: 1,
      candidate: { candidate: "c2", sdpMid: "0" },
    });
    await manager.handlePairIceCandidate({
      pairId: "1-2",
      pairEpoch: 1,
      candidate: null,
    });
    // Now the offer arrives; SRD completes; buffer flushes.
    await manager.handlePairOffer({
      pairId: "1-2",
      pairEpoch: 1,
      sdp: { type: "offer", sdp: "remote-offer\n" },
    });
    const pc = pcFactory.pcs[0]! as FakeRTCPeerConnection;
    // Three buffered + zero live = three applied; final entry is null.
    expect(pc.addedIceCandidates).toHaveLength(3);
    expect(pc.addedIceCandidates[0]).toMatchObject({ candidate: "c1" });
    expect(pc.addedIceCandidates[1]).toMatchObject({ candidate: "c2" });
    expect(pc.addedIceCandidates[2]).toBeNull();
    const flushEntries = entriesOfKind(dispatch, "ice_buffer_flushed");
    expect(flushEntries).toHaveLength(1);
    expect(flushEntries[0].detail.count).toBe(3);
  });

  it("applies ICE immediately once setRemoteDescription has resolved", async () => {
    const { manager, pcFactory } = makeManager();
    await manager.handleNegotiationInstruction({
      pairId: "1-2",
      pairEpoch: 1,
      role: "answerer",
      remotePeerId: PEER_B,
      remoteAdmissionIndex: 2,
      iceServers: ICE,
    });
    await manager.handlePairOffer({
      pairId: "1-2",
      pairEpoch: 1,
      sdp: { type: "offer", sdp: "remote-offer\n" },
    });
    await manager.handlePairIceCandidate({
      pairId: "1-2",
      pairEpoch: 1,
      candidate: { candidate: "c-live" },
    });
    const pc = pcFactory.pcs[0]! as FakeRTCPeerConnection;
    expect(pc.addedIceCandidates).toHaveLength(1);
    expect(pc.addedIceCandidates[0]).toMatchObject({ candidate: "c-live" });
  });

  it("drops stale-pairEpoch ICE without calling addIceCandidate", async () => {
    const { manager, dispatch, pcFactory } = makeManager();
    await manager.handleNegotiationInstruction({
      pairId: "1-2",
      pairEpoch: 5,
      role: "answerer",
      remotePeerId: PEER_B,
      remoteAdmissionIndex: 2,
      iceServers: ICE,
    });
    // SRD complete so any non-stale candidate would apply immediately.
    await manager.handlePairOffer({
      pairId: "1-2",
      pairEpoch: 5,
      sdp: { type: "offer", sdp: "remote-offer\n" },
    });
    const pc = pcFactory.pcs[0]! as FakeRTCPeerConnection;
    const beforeCount = pc.addedIceCandidates.length;

    await manager.handlePairIceCandidate({
      pairId: "1-2",
      pairEpoch: 4, // stale
      candidate: { candidate: "stale-cand" },
    });
    expect(pc.addedIceCandidates.length).toBe(beforeCount);
    const drops = entriesOfKind(dispatch, "pair_stale_message_dropped");
    const iceDrops = drops.filter(
      (e) => e.detail.inboundType === "pair_ice_candidate",
    );
    expect(iceDrops).toHaveLength(1);
    expect(iceDrops[0].detail.receivedEpoch).toBe(4);
    expect(iceDrops[0].detail.currentEpoch).toBe(5);
  });

  it("ignores ICE for an unknown pairId without mutating other pairs", async () => {
    const { manager, dispatch, pcFactory } = makeManager();
    await manager.handleNegotiationInstruction({
      pairId: "1-2",
      pairEpoch: 1,
      role: "answerer",
      remotePeerId: PEER_B,
      remoteAdmissionIndex: 2,
      iceServers: ICE,
    });
    await manager.handlePairOffer({
      pairId: "1-2",
      pairEpoch: 1,
      sdp: { type: "offer", sdp: "remote-offer\n" },
    });
    const pc = pcFactory.pcs[0]! as FakeRTCPeerConnection;
    const before = pc.addedIceCandidates.length;

    await manager.handlePairIceCandidate({
      pairId: "9-9", // unknown
      pairEpoch: 1,
      candidate: { candidate: "ghost" },
    });
    expect(pc.addedIceCandidates.length).toBe(before);
    const unknown = entriesOfKind(dispatch, "ice_candidate_unknown_pair");
    expect(unknown).toHaveLength(1);
  });

  it("does not cross-apply candidates between distinct PairContexts", async () => {
    const { manager, pcFactory } = makeManager();
    await manager.handleNewcomerInstructions([
      {
        pairId: "1-2",
        pairEpoch: 1,
        role: "answerer",
        remotePeerId: PEER_B,
        remoteAdmissionIndex: 2,
        iceServers: ICE,
      },
      {
        pairId: "1-3",
        pairEpoch: 1,
        role: "answerer",
        remotePeerId: PEER_C,
        remoteAdmissionIndex: 3,
        iceServers: ICE,
      },
    ]);
    await manager.handlePairOffer({
      pairId: "1-2",
      pairEpoch: 1,
      sdp: { type: "offer", sdp: "remote-offer-12\n" },
    });
    await manager.handlePairIceCandidate({
      pairId: "1-2",
      pairEpoch: 1,
      candidate: { candidate: "for-1-2" },
    });
    const pc12 = pcFactory.pcs[0]! as FakeRTCPeerConnection;
    const pc13 = pcFactory.pcs[1]! as FakeRTCPeerConnection;
    expect(pc12.addedIceCandidates).toHaveLength(1);
    expect(pc13.addedIceCandidates).toHaveLength(0);
  });
});

describe("PairManager — outbound ICE send loop (T056)", () => {
  it("emits pair_ice_candidate per local candidate and a final null for end-of-candidates", async () => {
    const { manager, send, pcFactory } = makeManager();
    await manager.handleNegotiationInstruction({
      pairId: "1-2",
      pairEpoch: 1,
      role: "offerer",
      remotePeerId: PEER_B,
      remoteAdmissionIndex: 2,
      iceServers: ICE,
    });
    const pc = pcFactory.pcs[0]! as FakeRTCPeerConnection;
    // Simulate two local candidates + EOC.
    pc.onicecandidate?.({
      candidate: {
        toJSON: () => ({ candidate: "local-c1", sdpMid: "0", sdpMLineIndex: 0 }),
      } as unknown as RTCIceCandidate,
    });
    pc.onicecandidate?.({
      candidate: {
        toJSON: () => ({ candidate: "local-c2", sdpMid: "0", sdpMLineIndex: 0 }),
      } as unknown as RTCIceCandidate,
    });
    pc.onicecandidate?.({ candidate: null });

    const iceMessages = send.mock.calls
      .map((c) => c[0])
      .filter((m) => m.type === "pair_ice_candidate");
    expect(iceMessages).toHaveLength(3);
    if (iceMessages[0]?.type !== "pair_ice_candidate") throw new Error("type");
    expect(iceMessages[0].payload.pairId).toBe("1-2");
    expect(iceMessages[0].payload.pairEpoch).toBe(1);
    expect(iceMessages[0].to).toBe(PEER_B);
    expect(iceMessages[0].payload.candidate).toMatchObject({
      candidate: "local-c1",
    });
    if (iceMessages[2]?.type !== "pair_ice_candidate") throw new Error("type");
    expect(iceMessages[2].payload.candidate).toBeNull();
  });

  it("never emits candidate:'' (empty string is forbidden by the contract)", async () => {
    const { manager, send, pcFactory } = makeManager();
    await manager.handleNegotiationInstruction({
      pairId: "1-2",
      pairEpoch: 1,
      role: "offerer",
      remotePeerId: PEER_B,
      remoteAdmissionIndex: 2,
      iceServers: ICE,
    });
    const pc = pcFactory.pcs[0]! as FakeRTCPeerConnection;
    pc.onicecandidate?.({ candidate: null });
    const ice = send.mock.calls
      .map((c) => c[0])
      .filter((m) => m.type === "pair_ice_candidate");
    for (const msg of ice) {
      if (msg.type !== "pair_ice_candidate") continue;
      const cand = msg.payload.candidate;
      if (cand !== null) {
        expect(cand.candidate).not.toBe("");
      }
    }
  });
});
