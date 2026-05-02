// T053 — pair.spec.ts. Covers PairContext + PairManager allocation
// behavior (T046), DataChannel ownership rule (T047), and the
// offer/answer handler happy paths (T048).
//
// Specifically:
//   - pair_negotiation_instruction creates a PairContext.
//   - duplicate instruction for same pairId + epoch is idempotent
//     (no second pc, no second sender, no duplicate datachannel).
//   - local audio/video tracks are reused across PairContexts (same
//     references — sender count invariant 2 × N−1).
//   - offerer creates the DataChannel BEFORE createOffer.
//   - answerer attaches the DataChannel via ondatachannel.
//   - offerer emits pair_offer after setLocalDescription.
//   - answerer emits pair_answer after setLocalDescription.
//   - both endpoints reach signalingState "stable" once the answer
//     completes the round-trip (mocked PC harness).

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
  type FakeRTCDataChannel,
  type FakeRTCPeerConnection,
} from "./pairTestHelpers";
import type { MeshClientMessage } from "../protocol/schema";

const ROOM_ID = "demo";
const SELF_PEER = "00000000-0000-4000-8000-000000000001";
const REMOTE_PEER_B = "00000000-0000-4000-8000-000000000002";

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
  return { manager, dispatch, send, tracks, pcFactory, role };
}

const DEFAULT_INSTRUCTION_ICE: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
];

describe("MeshPairManager — instruction allocation (T046)", () => {
  it("creates a PairContext on pair_negotiation_instruction", async () => {
    const { manager, pcFactory } = makeManager("offerer");
    const ctx = await manager.handleNegotiationInstruction({
      pairId: "1-2",
      pairEpoch: 1,
      role: "offerer",
      remotePeerId: REMOTE_PEER_B,
      remoteAdmissionIndex: 2,
      iceServers: DEFAULT_INSTRUCTION_ICE,
    });
    expect(ctx).not.toBeNull();
    expect(ctx?.pairId).toBe("1-2");
    expect(ctx?.pairEpoch).toBe(1);
    expect(ctx?.role).toBe("offerer");
    expect(pcFactory.pcs).toHaveLength(1);
  });

  it("is idempotent for duplicate instruction with same pairId + epoch", async () => {
    const { manager, pcFactory } = makeManager("offerer");
    const a = await manager.handleNegotiationInstruction({
      pairId: "1-2",
      pairEpoch: 1,
      role: "offerer",
      remotePeerId: REMOTE_PEER_B,
      remoteAdmissionIndex: 2,
      iceServers: DEFAULT_INSTRUCTION_ICE,
    });
    const b = await manager.handleNegotiationInstruction({
      pairId: "1-2",
      pairEpoch: 1,
      role: "offerer",
      remotePeerId: REMOTE_PEER_B,
      remoteAdmissionIndex: 2,
      iceServers: DEFAULT_INSTRUCTION_ICE,
    });
    expect(a).toBe(b); // same context returned
    expect(pcFactory.pcs).toHaveLength(1); // no second pc
    // and no second DC creation:
    const offererSpy = pcFactory.spies[0]!;
    const dcCreates = offererSpy.callOrder.filter(
      (s) => s === "createDataChannel",
    );
    expect(dcCreates).toHaveLength(1);
  });

  it("reuses local audio/video tracks across PairContexts", async () => {
    const { manager, pcFactory, tracks } = makeManager("offerer");
    await manager.handleNegotiationInstruction({
      pairId: "1-2",
      pairEpoch: 1,
      role: "offerer",
      remotePeerId: REMOTE_PEER_B,
      remoteAdmissionIndex: 2,
      iceServers: DEFAULT_INSTRUCTION_ICE,
    });
    await manager.handleNegotiationInstruction({
      pairId: "1-3",
      pairEpoch: 1,
      role: "offerer",
      remotePeerId: "00000000-0000-4000-8000-000000000003",
      remoteAdmissionIndex: 3,
      iceServers: DEFAULT_INSTRUCTION_ICE,
    });
    expect(pcFactory.pcs).toHaveLength(2);
    // Both pcs received the SAME track instances (referential equality).
    for (const spy of pcFactory.spies) {
      expect(spy.addedTracks).toHaveLength(2);
      expect(spy.addedTracks).toContain(tracks[0]);
      expect(spy.addedTracks).toContain(tracks[1]);
    }
    // Sender count invariant: 2 × number of PairContexts.
    const totalSenders = pcFactory.spies.reduce(
      (n, s) => n + s.senders.length,
      0,
    );
    expect(totalSenders).toBe(2 * 2);
  });
});

describe("MeshPairManager — DataChannel ownership rule (T047)", () => {
  it("offerer creates RTCDataChannel BEFORE createOffer", async () => {
    const { manager, pcFactory } = makeManager("offerer");
    await manager.handleNegotiationInstruction({
      pairId: "1-2",
      pairEpoch: 1,
      role: "offerer",
      remotePeerId: REMOTE_PEER_B,
      remoteAdmissionIndex: 2,
      iceServers: DEFAULT_INSTRUCTION_ICE,
    });
    const order = pcFactory.spies[0]!.callOrder;
    const dcIdx = order.indexOf("createDataChannel");
    const offerIdx = order.indexOf("createOffer");
    expect(dcIdx).toBeGreaterThan(-1);
    expect(offerIdx).toBeGreaterThan(-1);
    expect(dcIdx).toBeLessThan(offerIdx);
    // Channel name + ordered flag per FR-050.
    const dc = pcFactory.spies[0]!.createdChannels[0]!;
    expect(dc.label).toBe("mesh-chat");
    expect(dc.ordered).toBe(true);
  });

  it("answerer attaches DataChannel via ondatachannel and never calls createDataChannel", async () => {
    const { manager, pcFactory } = makeManager("answerer");
    await manager.handleNegotiationInstruction({
      pairId: "1-2",
      pairEpoch: 1,
      role: "answerer",
      remotePeerId: REMOTE_PEER_B,
      remoteAdmissionIndex: 2,
      iceServers: DEFAULT_INSTRUCTION_ICE,
    });
    const order = pcFactory.spies[0]!.callOrder;
    expect(order).not.toContain("createDataChannel");
    // ondatachannel should be wired; deliver a synthetic channel and
    // verify the manager attached it to the PairContext.
    const pc = pcFactory.pcs[0]!;
    expect(typeof pc.ondatachannel).toBe("function");
    const fakeDC = { label: "mesh-chat", readyState: "connecting" } as unknown as FakeRTCDataChannel;
    pc.deliverDataChannel(fakeDC);
    const ctx = manager.getContext("1-2");
    expect(ctx?.dc).toBe(fakeDC as unknown as RTCDataChannel);
  });
});

describe("MeshPairManager — offer/answer flow (T048)", () => {
  it("offerer emits pair_offer after setLocalDescription, then reaches stable on pair_answer", async () => {
    const { manager, send, pcFactory } = makeManager("offerer");
    await manager.handleNegotiationInstruction({
      pairId: "1-2",
      pairEpoch: 1,
      role: "offerer",
      remotePeerId: REMOTE_PEER_B,
      remoteAdmissionIndex: 2,
      iceServers: DEFAULT_INSTRUCTION_ICE,
    });
    // Send sequence: pair_offer with the right pair identity.
    expect(send).toHaveBeenCalledTimes(1);
    const sentMsg = send.mock.calls[0]![0];
    expect(sentMsg.type).toBe("pair_offer");
    if (sentMsg.type === "pair_offer") {
      expect(sentMsg.payload.pairId).toBe("1-2");
      expect(sentMsg.payload.pairEpoch).toBe(1);
      expect(sentMsg.payload.sdp.type).toBe("offer");
      expect(sentMsg.to).toBe(REMOTE_PEER_B);
    }
    // Order: setLocalDescription(offer) precedes the send.
    const order = pcFactory.spies[0]!.callOrder;
    expect(order.indexOf("setLocalDescription(offer)")).toBeGreaterThan(-1);

    // Now feed a pair_answer back; signalingState reaches stable.
    await manager.handlePairAnswer({
      pairId: "1-2",
      pairEpoch: 1,
      sdp: { type: "answer", sdp: "remote-answer-sdp\n" },
    });
    const pc = pcFactory.pcs[0]! as FakeRTCPeerConnection;
    expect(pc.signalingState).toBe("stable");
    expect(manager.getContext("1-2")?.state).toBe("stable");
  });

  it("answerer emits pair_answer after setLocalDescription on inbound pair_offer", async () => {
    const { manager, send, pcFactory } = makeManager("answerer");
    await manager.handleNegotiationInstruction({
      pairId: "1-2",
      pairEpoch: 1,
      role: "answerer",
      remotePeerId: REMOTE_PEER_B,
      remoteAdmissionIndex: 2,
      iceServers: DEFAULT_INSTRUCTION_ICE,
    });
    expect(send).not.toHaveBeenCalled(); // answerer doesn't emit until offer arrives

    await manager.handlePairOffer({
      pairId: "1-2",
      pairEpoch: 1,
      sdp: { type: "offer", sdp: "remote-offer-sdp\n" },
    });
    expect(send).toHaveBeenCalledTimes(1);
    const sent = send.mock.calls[0]![0];
    expect(sent.type).toBe("pair_answer");
    if (sent.type === "pair_answer") {
      expect(sent.payload.pairId).toBe("1-2");
      expect(sent.payload.pairEpoch).toBe(1);
      expect(sent.payload.sdp.type).toBe("answer");
      expect(sent.to).toBe(REMOTE_PEER_B);
    }
    const order = pcFactory.spies[0]!.callOrder;
    // Order asserted: setRemoteDescription(offer) → createAnswer →
    // setLocalDescription(answer) → (then send is invoked).
    const setRDIdx = order.indexOf("setRemoteDescription(offer)");
    const createAnsIdx = order.indexOf("createAnswer");
    const setLDIdx = order.indexOf("setLocalDescription(answer)");
    expect(setRDIdx).toBeGreaterThan(-1);
    expect(createAnsIdx).toBeGreaterThan(setRDIdx);
    expect(setLDIdx).toBeGreaterThan(createAnsIdx);
    // Answerer's pc reaches stable after setLocalDescription(answer).
    const pc = pcFactory.pcs[0]! as FakeRTCPeerConnection;
    expect(pc.signalingState).toBe("stable");
  });

  it("both endpoints reach signalingState=stable in a paired harness", async () => {
    // Simulate two managers (one offerer, one answerer) and shuttle
    // the SDP between them. This is the closest M6-compatible
    // analogue of "both reach stable" without a real WebRTC stack.
    const o = makeManager("offerer");
    const a = makeManager("answerer");

    await o.manager.handleNegotiationInstruction({
      pairId: "1-2",
      pairEpoch: 1,
      role: "offerer",
      remotePeerId: REMOTE_PEER_B,
      remoteAdmissionIndex: 2,
      iceServers: DEFAULT_INSTRUCTION_ICE,
    });
    await a.manager.handleNegotiationInstruction({
      pairId: "1-2",
      pairEpoch: 1,
      role: "answerer",
      remotePeerId: SELF_PEER,
      remoteAdmissionIndex: 1,
      iceServers: DEFAULT_INSTRUCTION_ICE,
    });

    // Offerer's pair_offer goes to answerer.
    const offered = o.send.mock.calls[0]![0];
    expect(offered.type).toBe("pair_offer");
    if (offered.type !== "pair_offer") throw new Error("type narrowing");
    await a.manager.handlePairOffer({
      pairId: "1-2",
      pairEpoch: 1,
      sdp: { type: "offer", sdp: offered.payload.sdp.sdp },
    });

    // Answerer's pair_answer goes back to offerer.
    const answered = a.send.mock.calls[0]![0];
    expect(answered.type).toBe("pair_answer");
    if (answered.type !== "pair_answer") throw new Error("type narrowing");
    await o.manager.handlePairAnswer({
      pairId: "1-2",
      pairEpoch: 1,
      sdp: { type: "answer", sdp: answered.payload.sdp.sdp },
    });

    expect(
      (o.pcFactory.pcs[0]! as FakeRTCPeerConnection).signalingState,
    ).toBe("stable");
    expect(
      (a.pcFactory.pcs[0]! as FakeRTCPeerConnection).signalingState,
    ).toBe("stable");
  });
});
