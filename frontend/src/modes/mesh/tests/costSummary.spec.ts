// T059 — costSummary.spec.ts. Asserts the FR-070 / FR-071 / NFR-007 /
// SC-008 cost-derivation rules at N ∈ {1, 2, 3, 4}:
//   - room-wide pair total = N × (N − 1) / 2
//   - local PC count = number of PairContexts (≈ N − 1 in steady state)
//   - outgoing sender count = 2 × local PC count

import { describe, expect, it } from "vitest";
import { computeMeshCost } from "../state/cost";
import {
  initialMeshPairsSlice,
  meshPairsReducer,
  type MeshPairsAction,
} from "../state/pairs";
import type { MeshRosterSlice } from "../state/roster";
import {
  initialMeshLocalParticipant,
  type MeshLocalParticipant,
} from "../state/local";

const ADMITTED: MeshLocalParticipant = {
  ...initialMeshLocalParticipant,
  fsm: "media-ready",
  peerId: "00000000-0000-4000-8000-000000000001",
  admissionIndex: 1,
};

function rosterWith(remoteCount: number): MeshRosterSlice {
  const byPeerId: MeshRosterSlice["byPeerId"] = {};
  for (let i = 0; i < remoteCount; i++) {
    const idx = i + 2;
    const peerId = `00000000-0000-4000-8000-${String(i + 2).padStart(12, "0")}`;
    (byPeerId as Record<string, unknown>)[peerId] = {
      peerId,
      admissionIndex: idx,
      presence: "media-ready",
      joinedAt: 0,
    };
  }
  return { serverSeq: remoteCount, byPeerId };
}

function pairsWith(
  remotes: ReadonlyArray<{ peerId: string; admissionIndex: number }>,
  connectionState: RTCPeerConnectionState = "connected",
) {
  let slice = initialMeshPairsSlice;
  for (const r of remotes) {
    const pairId = `1-${r.admissionIndex}`;
    const reg: MeshPairsAction = {
      type: "MESH_PAIR_REGISTERED",
      pairId,
      pairEpoch: 1,
      role: "offerer",
      remotePeerId: r.peerId,
      remoteAdmissionIndex: r.admissionIndex,
    };
    slice = meshPairsReducer(slice, reg);
    const patch: MeshPairsAction = {
      type: "MESH_PAIR_VIEW_PATCHED",
      pairId,
      patch: { connectionState },
    };
    slice = meshPairsReducer(slice, patch);
  }
  return slice;
}

function remotesFromRoster(roster: MeshRosterSlice) {
  return Object.values(roster.byPeerId).map((p) => ({
    peerId: p.peerId,
    admissionIndex: p.admissionIndex,
  }));
}

describe("computeMeshCost — formulas at N ∈ {1, 2, 3, 4}", () => {
  it("N = 1: zero PCs, zero pair total", () => {
    const roster = rosterWith(0);
    const cost = computeMeshCost({
      local: ADMITTED,
      roster,
      pairs: initialMeshPairsSlice,
    });
    expect(cost.participants).toBe(1);
    expect(cost.localPeerConnectionCount).toBe(0);
    expect(cost.localDataChannelCount).toBe(0);
    expect(cost.outgoingAudioSenderCount).toBe(0);
    expect(cost.outgoingVideoSenderCount).toBe(0);
    expect(cost.outgoingSenderCount).toBe(0);
    expect(cost.totalRoomPairCount).toBe(0);
    expect(cost.connectedPairCount).toBe(0);
  });

  it("N = 2: one PC, one DC, one room-wide pair", () => {
    const roster = rosterWith(1);
    const pairs = pairsWith(remotesFromRoster(roster));
    const cost = computeMeshCost({ local: ADMITTED, roster, pairs });
    expect(cost.participants).toBe(2);
    expect(cost.localPeerConnectionCount).toBe(1);
    expect(cost.localDataChannelCount).toBe(1);
    expect(cost.outgoingAudioSenderCount).toBe(1);
    expect(cost.outgoingVideoSenderCount).toBe(1);
    expect(cost.outgoingSenderCount).toBe(2);
    expect(cost.totalRoomPairCount).toBe(1);
    expect(cost.connectedPairCount).toBe(1);
  });

  it("N = 3: two PCs, three room-wide pairs", () => {
    const roster = rosterWith(2);
    const pairs = pairsWith(remotesFromRoster(roster));
    const cost = computeMeshCost({ local: ADMITTED, roster, pairs });
    expect(cost.participants).toBe(3);
    expect(cost.localPeerConnectionCount).toBe(2);
    expect(cost.localDataChannelCount).toBe(2);
    expect(cost.outgoingAudioSenderCount).toBe(2);
    expect(cost.outgoingVideoSenderCount).toBe(2);
    expect(cost.outgoingSenderCount).toBe(4);
    expect(cost.totalRoomPairCount).toBe(3);
    expect(cost.connectedPairCount).toBe(2);
  });

  it("N = 4: three PCs, six room-wide pairs (the SC-008 case)", () => {
    const roster = rosterWith(3);
    const pairs = pairsWith(remotesFromRoster(roster));
    const cost = computeMeshCost({ local: ADMITTED, roster, pairs });
    expect(cost.participants).toBe(4);
    expect(cost.localPeerConnectionCount).toBe(3);
    expect(cost.localDataChannelCount).toBe(3);
    expect(cost.outgoingAudioSenderCount).toBe(3);
    expect(cost.outgoingVideoSenderCount).toBe(3);
    expect(cost.outgoingSenderCount).toBe(6);
    expect(cost.totalRoomPairCount).toBe(6);
    expect(cost.connectedPairCount).toBe(3);
  });

  it("local sender count = 2 × active local PairContexts (FR-070 invariant)", () => {
    const roster = rosterWith(3);
    const pairs = pairsWith(remotesFromRoster(roster));
    const cost = computeMeshCost({ local: ADMITTED, roster, pairs });
    expect(cost.outgoingSenderCount).toBe(2 * cost.localPeerConnectionCount);
  });
});

describe("computeMeshCost — pair categorization", () => {
  it("buckets pairs into connected / connecting / failed / pending", () => {
    const roster = rosterWith(3);
    const remotes = remotesFromRoster(roster);
    let pairs = pairsWith([remotes[0]!], "connected");
    pairs = meshPairsReducer(
      meshPairsReducer(pairs, {
        type: "MESH_PAIR_REGISTERED",
        pairId: `1-${remotes[1]!.admissionIndex}`,
        pairEpoch: 1,
        role: "offerer",
        remotePeerId: remotes[1]!.peerId,
        remoteAdmissionIndex: remotes[1]!.admissionIndex,
      }),
      {
        type: "MESH_PAIR_VIEW_PATCHED",
        pairId: `1-${remotes[1]!.admissionIndex}`,
        patch: { connectionState: "connecting" },
      },
    );
    pairs = meshPairsReducer(
      meshPairsReducer(pairs, {
        type: "MESH_PAIR_REGISTERED",
        pairId: `1-${remotes[2]!.admissionIndex}`,
        pairEpoch: 1,
        role: "offerer",
        remotePeerId: remotes[2]!.peerId,
        remoteAdmissionIndex: remotes[2]!.admissionIndex,
      }),
      {
        type: "MESH_PAIR_VIEW_PATCHED",
        pairId: `1-${remotes[2]!.admissionIndex}`,
        patch: { connectionState: "failed" },
      },
    );
    const cost = computeMeshCost({ local: ADMITTED, roster, pairs });
    expect(cost.connectedPairCount).toBe(1);
    expect(cost.connectingPairCount).toBe(1);
    expect(cost.failedPairCount).toBe(1);
    expect(cost.pendingPairCount).toBe(0);
  });
});
