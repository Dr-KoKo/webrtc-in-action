// T053 — pairEpoch.spec.ts. Covers the client-side stale-epoch guard
// (T050). Inbound pair_offer / pair_answer with payload.pairEpoch
// different from PairContext.pairEpoch must:
//   - NOT call setRemoteDescription
//   - NOT mutate the active PairContext state
//   - emit a peer-scoped `pair_stale_message_dropped` event-log entry.

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
  type FakeRTCPeerConnection,
} from "./pairTestHelpers";
import type { MeshClientMessage } from "../protocol/schema";

const ROOM_ID = "demo";
const SELF_PEER = "00000000-0000-4000-8000-000000000001";
const REMOTE_PEER_B = "00000000-0000-4000-8000-000000000002";
const ICE: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

function makeManager(role: "offerer" | "answerer") {
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
  const manager = createMeshPairManager(deps);
  return { manager, dispatch, send, pcFactory, role };
}

function staleDropEntries(dispatch: ReturnType<typeof vi.fn>) {
  return dispatch.mock.calls
    .map((c) => c[0])
    .filter(
      (a) =>
        a?.type === "MESH_EVENT_APPEND" &&
        a.entry?.detail?.kind === "pair_stale_message_dropped",
    );
}

describe("MeshPairManager — client-side stale-epoch guard (T050)", () => {
  it("stale pair_offer does NOT call setRemoteDescription on the answerer", async () => {
    const { manager, dispatch, pcFactory } = makeManager("answerer");
    await manager.handleNegotiationInstruction({
      pairId: "1-2",
      pairEpoch: 5, // current epoch
      role: "answerer",
      remotePeerId: REMOTE_PEER_B,
      remoteAdmissionIndex: 2,
      iceServers: ICE,
    });
    const pc = pcFactory.pcs[0]! as FakeRTCPeerConnection;
    const orderBefore = [...pcFactory.spies[0]!.callOrder];
    const stateBefore = manager.snapshotContext("1-2");

    await manager.handlePairOffer({
      pairId: "1-2",
      pairEpoch: 4, // strictly stale
      sdp: { type: "offer", sdp: "stale-offer\n" },
    });

    // No setRemoteDescription side-effect.
    const newCalls = pcFactory.spies[0]!.callOrder.slice(orderBefore.length);
    expect(newCalls).not.toContain("setRemoteDescription(offer)");
    // PairContext state untouched.
    const stateAfter = manager.snapshotContext("1-2");
    expect(stateAfter?.state).toBe(stateBefore?.state);
    expect(stateAfter?.pairEpoch).toBe(stateBefore?.pairEpoch);
    expect(pc.remoteDescription).toBeNull();
    // Event log emitted pair_stale_message_dropped.
    const drops = staleDropEntries(dispatch);
    expect(drops).toHaveLength(1);
    expect(drops[0].entry.detail.receivedEpoch).toBe(4);
    expect(drops[0].entry.detail.currentEpoch).toBe(5);
    expect(drops[0].entry.detail.inboundType).toBe("pair_offer");
    expect(drops[0].entry.peerId).toBe(REMOTE_PEER_B);
    expect(drops[0].entry.pairId).toBe("1-2");
  });

  it("stale pair_answer does NOT mutate offerer PairContext", async () => {
    const { manager, dispatch, pcFactory } = makeManager("offerer");
    await manager.handleNegotiationInstruction({
      pairId: "1-2",
      pairEpoch: 5,
      role: "offerer",
      remotePeerId: REMOTE_PEER_B,
      remoteAdmissionIndex: 2,
      iceServers: ICE,
    });
    const pc = pcFactory.pcs[0]! as FakeRTCPeerConnection;
    const stateBefore = manager.snapshotContext("1-2");
    const orderBefore = [...pcFactory.spies[0]!.callOrder];

    await manager.handlePairAnswer({
      pairId: "1-2",
      pairEpoch: 4, // strictly stale
      sdp: { type: "answer", sdp: "stale-answer\n" },
    });

    const newCalls = pcFactory.spies[0]!.callOrder.slice(orderBefore.length);
    expect(newCalls).not.toContain("setRemoteDescription(answer)");
    const stateAfter = manager.snapshotContext("1-2");
    // The pre-stale state is "have-local-offer" (offer was sent during
    // allocation); after the stale drop it must be unchanged.
    expect(stateAfter?.state).toBe(stateBefore?.state);
    expect(stateAfter?.pairEpoch).toBe(5);
    expect(pc.remoteDescription).toBeNull();

    const drops = staleDropEntries(dispatch);
    expect(drops).toHaveLength(1);
    expect(drops[0].entry.detail.inboundType).toBe("pair_answer");
    expect(drops[0].entry.detail.receivedEpoch).toBe(4);
    expect(drops[0].entry.detail.currentEpoch).toBe(5);
  });

  it("higher-than-current epoch on inbound pair message is also dropped (server is canonical)", async () => {
    const { manager, dispatch, pcFactory } = makeManager("answerer");
    await manager.handleNegotiationInstruction({
      pairId: "1-2",
      pairEpoch: 1,
      role: "answerer",
      remotePeerId: REMOTE_PEER_B,
      remoteAdmissionIndex: 2,
      iceServers: ICE,
    });
    await manager.handlePairOffer({
      pairId: "1-2",
      pairEpoch: 9,
      sdp: { type: "offer", sdp: "future-offer\n" },
    });
    const pc = pcFactory.pcs[0]! as FakeRTCPeerConnection;
    expect(pc.remoteDescription).toBeNull();
    expect(staleDropEntries(dispatch)).toHaveLength(1);
  });
});
