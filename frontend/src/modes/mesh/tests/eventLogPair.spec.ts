// T060 — eventLogPair.spec.ts. Asserts the per-pair lifecycle event
// stream invariants:
//   - every pair-scoped entry carries pairId + peerId (FR-061)
//   - ICE candidate sent / received entries DO NOT include the raw
//     candidate string (NFR-003 — ICE strings carry TURN credentials)
//   - remote track received includes pairId + remotePeerId + track kind

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
import type { MeshClientMessage } from "../signaling/schema";
import type { MeshEventEntry } from "../state/eventLog";

const ROOM_ID = "demo";
const SELF_PEER = "00000000-0000-4000-8000-000000000001";
const PEER_B = "00000000-0000-4000-8000-000000000002";
const ICE: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

const RAW_CANDIDATE_STRING =
  "candidate:842163049 1 udp 1677729535 192.0.2.1 56789 typ srflx raddr 0.0.0.0 rport 0";

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

function entries(dispatch: ReturnType<typeof vi.fn>): MeshEventEntry[] {
  return dispatch.mock.calls
    .map((c) => c[0])
    .filter((a) => a?.type === "MESH_EVENT_APPEND")
    .map((a) => a.entry as MeshEventEntry);
}

describe("Mesh event log — per-pair lifecycle entries (T060)", () => {
  it("ICE candidate sent / received entries DO NOT include the raw candidate string", async () => {
    const { manager, send, pcFactory, dispatch } = makeManager();
    await manager.handleNegotiationInstruction({
      pairId: "1-2",
      pairEpoch: 1,
      role: "answerer",
      remotePeerId: PEER_B,
      remoteAdmissionIndex: 2,
      iceServers: ICE,
    });
    const pc = pcFactory.pcs[0]! as FakeRTCPeerConnection;
    // Local outbound candidate.
    pc.onicecandidate?.({
      candidate: {
        toJSON: () => ({
          candidate: RAW_CANDIDATE_STRING,
          sdpMid: "0",
          sdpMLineIndex: 0,
          usernameFragment: "abcd1234",
        }),
      } as unknown as RTCIceCandidate,
    });

    // Remote inbound candidate (after SRD so it applies live).
    await manager.handlePairOffer({
      pairId: "1-2",
      pairEpoch: 1,
      sdp: { type: "offer", sdp: "remote-offer\n" },
    });
    await manager.handlePairIceCandidate({
      pairId: "1-2",
      pairEpoch: 1,
      candidate: {
        candidate: RAW_CANDIDATE_STRING,
        sdpMid: "0",
        sdpMLineIndex: 0,
      },
    });

    // Every event-log entry must omit the raw candidate string from
    // both `summary` and `detail`. We round-trip the entry to JSON
    // (the event log is logged + serialized in real builds) and grep.
    for (const entry of entries(dispatch)) {
      const serialized = JSON.stringify(entry);
      expect(serialized).not.toContain(RAW_CANDIDATE_STRING);
    }
    // The send loop must have emitted the candidate over the wire
    // (only ever to the remote peer, not via the event log).
    const ice = send.mock.calls
      .map((c) => c[0])
      .filter((m) => m.type === "pair_ice_candidate");
    expect(ice).toHaveLength(1);
  });

  it("every pair-scoped lifecycle entry carries pairId + peerId", async () => {
    const { manager, pcFactory, dispatch } = makeManager();
    await manager.handleNegotiationInstruction({
      pairId: "1-2",
      pairEpoch: 1,
      role: "answerer",
      remotePeerId: PEER_B,
      remoteAdmissionIndex: 2,
      iceServers: ICE,
    });
    const pc = pcFactory.pcs[0]! as FakeRTCPeerConnection;
    // Trigger a few state changes synthetically.
    pc.iceConnectionState = "checking";
    pc.oniceconnectionstatechange?.();
    pc.iceGatheringState = "gathering";
    pc.onicegatheringstatechange?.();
    pc.connectionState = "connecting";
    pc.onconnectionstatechange?.();

    const pairScoped = entries(dispatch).filter((e) => e.scope === "pair");
    expect(pairScoped.length).toBeGreaterThan(0);
    for (const e of pairScoped) {
      expect(e.peerId).toBe(PEER_B);
      expect(e.pairId).toBe("1-2");
    }
  });

  it("remote track received includes pairId + remotePeerId + track kind", async () => {
    const { manager, pcFactory, dispatch } = makeManager();
    await manager.handleNegotiationInstruction({
      pairId: "1-2",
      pairEpoch: 1,
      role: "answerer",
      remotePeerId: PEER_B,
      remoteAdmissionIndex: 2,
      iceServers: ICE,
    });
    const pc = pcFactory.pcs[0]! as FakeRTCPeerConnection;
    const remoteStream = { id: "remote" } as unknown as MediaStream;
    pc.ontrack?.({
      track: { kind: "video" } as MediaStreamTrack,
      streams: [remoteStream],
    } as unknown as RTCTrackEvent);
    pc.ontrack?.({
      track: { kind: "audio" } as MediaStreamTrack,
      streams: [remoteStream],
    } as unknown as RTCTrackEvent);

    const tracks = entries(dispatch).filter(
      (e) => e.detail?.kind === "remote_track_received",
    );
    expect(tracks).toHaveLength(2);
    for (const e of tracks) {
      expect(e.peerId).toBe(PEER_B);
      expect(e.pairId).toBe("1-2");
    }
    expect(tracks.map((e) => e.detail?.trackKind).sort()).toEqual([
      "audio",
      "video",
    ]);
  });
});
