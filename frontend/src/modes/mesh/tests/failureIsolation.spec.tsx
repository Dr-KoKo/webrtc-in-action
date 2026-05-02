// T087 — failureIsolation.spec.ts (M11 / FR-025 / L15).
//
// Per-pair failure isolation. Asserts that:
//   - When ONE PairContext's pc.connectionState transitions to "failed",
//     ONLY that PairContext is marked failed; siblings keep their state.
//   - One outbound `pair_failed` envelope is emitted, addressed to the
//     remote endpoint of the affected pair.
//   - Inbound `pair_failed` from the remote marks ONLY the matching
//     PairContext failed; stale-epoch payloads are dropped + logged.
//   - PartialMeshBadge truth table — visible iff ≥1 failed AND ≥1
//     connected pair exists.

import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
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
import { PartialMeshBadge } from "../components/PartialMeshBadge";
import {
  MeshStoreProvider,
  initialMeshRootState,
  type MeshRootState,
} from "../state";

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
  const manager = createMeshPairManager(deps);
  return { manager, dispatch, send, pcFactory };
}

async function allocate(
  manager: ReturnType<typeof makeManager>["manager"],
  pairId: string,
  remotePeerId: string,
  remoteIdx: number,
  epoch = 1,
) {
  return manager.handleNegotiationInstruction({
    pairId,
    pairEpoch: epoch,
    role: "offerer",
    remotePeerId,
    remoteAdmissionIndex: remoteIdx,
    iceServers: ICE,
  });
}

function pairFailedSends(send: ReturnType<typeof vi.fn>): MeshClientMessage[] {
  return send.mock.calls
    .map((c) => c[0] as MeshClientMessage)
    .filter((m) => m.type === "pair_failed");
}

function eventEntries(dispatch: ReturnType<typeof vi.fn>) {
  return dispatch.mock.calls
    .map((c) => c[0])
    .filter((a) => a?.type === "MESH_EVENT_APPEND")
    .map((a) => a.entry);
}

describe("Per-pair failure isolation (M11 / T081 / FR-025)", () => {
  it("local pc.connectionState=failed marks ONLY that PairContext failed", async () => {
    const { manager, send, pcFactory } = makeManager();
    await allocate(manager, "1-2", PEER_B, 2);
    await allocate(manager, "1-3", PEER_C, 3);
    const pcAB = pcFactory.pcs[0]! as FakeRTCPeerConnection;
    const pcAC = pcFactory.pcs[1]! as FakeRTCPeerConnection;

    // Sibling stays "connected".
    pcAC.connectionState = "connected";
    pcAC.onconnectionstatechange?.();

    // Affected pair fails.
    pcAB.connectionState = "failed";
    pcAB.onconnectionstatechange?.();

    expect(manager.snapshotContext("1-2")?.state).toBe("failed");
    expect(manager.snapshotContext("1-3")?.state).not.toBe("failed");
    // Other PC's reference identity is preserved.
    expect(manager.getContext("1-3")?.pc).toBe(pcAC as unknown as RTCPeerConnection);

    const failedSends = pairFailedSends(send);
    expect(failedSends).toHaveLength(1);
    const env = failedSends[0]!;
    if (env.type !== "pair_failed") throw new Error("type narrow");
    expect(env.to).toBe(PEER_B);
    expect(env.payload.pairId).toBe("1-2");
    expect(env.payload.pairEpoch).toBe(1);
    expect(env.payload.reason).toBe("connection_state_failed");
  });

  it("emits exactly one pair_failed per attempt even on repeated failed events", async () => {
    const { manager, send, pcFactory } = makeManager();
    await allocate(manager, "1-2", PEER_B, 2);
    const pc = pcFactory.pcs[0]! as FakeRTCPeerConnection;
    pc.connectionState = "failed";
    pc.onconnectionstatechange?.();
    pc.onconnectionstatechange?.(); // duplicate event
    expect(pairFailedSends(send)).toHaveLength(1);
  });

  it("emits the canonical event-log entry for local failure", async () => {
    const { manager, dispatch, pcFactory } = makeManager();
    await allocate(manager, "1-2", PEER_B, 2);
    const pc = pcFactory.pcs[0]! as FakeRTCPeerConnection;
    pc.connectionState = "failed";
    pc.onconnectionstatechange?.();
    const failedEntries = eventEntries(dispatch).filter(
      (e) => e.detail?.kind === "peer_pair_failed",
    );
    expect(failedEntries).toHaveLength(1);
    const entry = failedEntries[0]!;
    expect(entry.scope).toBe("pair");
    expect(entry.pairId).toBe("1-2");
    expect(entry.peerId).toBe(PEER_B);
    expect(entry.detail.reason).toBe("connection_state_failed");
    expect(entry.detail.connectionState).toBe("failed");
    expect(entry.detail.direction).toBe("local");
    expect(entry.detail.remotePeerId).toBe(PEER_B);
    expect(entry.summary).toMatch(/peer pair failed/);
  });

  it("inbound pair_failed marks ONLY the matching PairContext failed", async () => {
    const { manager, dispatch } = makeManager();
    await allocate(manager, "1-2", PEER_B, 2);
    await allocate(manager, "1-3", PEER_C, 3);

    manager.handlePairFailed({
      pairId: "1-2",
      pairEpoch: 1,
      reason: "ice_failure",
      detail: "remote-detected",
    });
    expect(manager.snapshotContext("1-2")?.state).toBe("failed");
    expect(manager.snapshotContext("1-3")?.state).not.toBe("failed");
    const remoteFailEntries = eventEntries(dispatch).filter(
      (e) => e.detail?.kind === "peer_pair_failed" && e.detail?.direction === "remote",
    );
    expect(remoteFailEntries).toHaveLength(1);
    expect(remoteFailEntries[0]!.detail.reason).toBe("ice_failure");
  });

  it("inbound pair_failed with stale pairEpoch is dropped + logged", async () => {
    const { manager, dispatch } = makeManager();
    await allocate(manager, "1-2", PEER_B, 2, 5);
    manager.handlePairFailed({
      pairId: "1-2",
      pairEpoch: 4, // strictly stale
      reason: "ice_failure",
    });
    expect(manager.snapshotContext("1-2")?.state).not.toBe("failed");
    const drops = eventEntries(dispatch).filter(
      (e) => e.detail?.kind === "pair_stale_message_dropped",
    );
    expect(drops.some((d) => d.detail.inboundType === "pair_failed")).toBe(true);
  });

  it("local pair failure does NOT close other PCs or stop senders", async () => {
    const { manager, pcFactory } = makeManager();
    await allocate(manager, "1-2", PEER_B, 2);
    await allocate(manager, "1-3", PEER_C, 3);
    const sibling = pcFactory.pcs[1]! as FakeRTCPeerConnection;
    const sibSendersBefore = manager.getContext("1-3")?.senders;

    const failingPc = pcFactory.pcs[0]! as FakeRTCPeerConnection;
    failingPc.connectionState = "failed";
    failingPc.onconnectionstatechange?.();

    expect(sibling.connectionState).not.toBe("closed");
    expect(manager.getContext("1-3")?.senders).toBe(sibSendersBefore);
  });
});

describe("PartialMeshBadge truth table (M11 / T082 / FR-065)", () => {
  function renderWithPairs(views: Array<{
    pairId: string;
    remotePeerId: string;
    remoteAdmissionIndex: number;
    connectionState: RTCPeerConnectionState;
  }>) {
    const byPairId: Record<string, unknown> = {};
    for (const v of views) {
      byPairId[v.pairId] = {
        pairId: v.pairId,
        pairEpoch: 1,
        role: "offerer" as const,
        remotePeerId: v.remotePeerId,
        remoteAdmissionIndex: v.remoteAdmissionIndex,
        connectionState: v.connectionState,
        iceConnectionState: "new" as RTCIceConnectionState,
        iceGatheringState: "new" as RTCIceGatheringState,
        signalingState: "stable" as RTCSignalingState,
        dataChannelState: "pending" as const,
        remoteStream: null,
        reconnectRequested: false,
      };
    }
    const initial: MeshRootState = {
      ...initialMeshRootState,
      pairs: { byPairId: byPairId as never },
    };
    return render(
      <MeshStoreProvider initialState={initial}>
        <PartialMeshBadge />
      </MeshStoreProvider>,
    );
  }

  it("hidden when zero failed pairs", () => {
    const { getByTestId } = renderWithPairs([
      { pairId: "1-2", remotePeerId: PEER_B, remoteAdmissionIndex: 2, connectionState: "connected" },
      { pairId: "1-3", remotePeerId: PEER_C, remoteAdmissionIndex: 3, connectionState: "connected" },
    ]);
    expect(getByTestId("mesh-partial-mesh-badge").getAttribute("data-visible")).toBe("false");
  });

  it("hidden when all pairs failed (no connected pair remains)", () => {
    const { getByTestId } = renderWithPairs([
      { pairId: "1-2", remotePeerId: PEER_B, remoteAdmissionIndex: 2, connectionState: "failed" },
      { pairId: "1-3", remotePeerId: PEER_C, remoteAdmissionIndex: 3, connectionState: "failed" },
    ]);
    expect(getByTestId("mesh-partial-mesh-badge").getAttribute("data-visible")).toBe("false");
  });

  it("visible when ≥1 failed AND ≥1 connected", () => {
    const { getByTestId } = renderWithPairs([
      { pairId: "1-2", remotePeerId: PEER_B, remoteAdmissionIndex: 2, connectionState: "failed" },
      { pairId: "1-3", remotePeerId: PEER_C, remoteAdmissionIndex: 3, connectionState: "connected" },
    ]);
    const badge = getByTestId("mesh-partial-mesh-badge");
    expect(badge.getAttribute("data-visible")).toBe("true");
    expect(badge.getAttribute("data-failed-count")).toBe("1");
    expect(badge.getAttribute("data-connected-count")).toBe("1");
    expect(badge.textContent).toContain("Partial mesh: some peer pairs failed");
  });

  it("hidden when only one pair exists and it is failed", () => {
    const { getByTestId } = renderWithPairs([
      { pairId: "1-2", remotePeerId: PEER_B, remoteAdmissionIndex: 2, connectionState: "failed" },
    ]);
    expect(getByTestId("mesh-partial-mesh-badge").getAttribute("data-visible")).toBe("false");
  });
});
