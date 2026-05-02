// Mesh cost summary derivation (T059, FR-070, FR-071, NFR-007).
// Renders the L14 surface — the O(N) cost shape per local participant
// against the O(N²) cost shape per room.
//
// Counts are derived on demand from `Roster` + `LocalParticipant` +
// `MeshPairsSlice`. Nothing is cached; state-tree mutations re-compute.
//
// Derivation rules (data-model §B.4 + spec FR-070):
//   - participants `N` includes the local participant whenever the
//     local FSM is at or beyond `media-ready` AND a roster snapshot
//     has been received. Pre-`media-ready` we count only what the
//     server has acknowledged (FR-070 is a *display* surface; over-
//     counting would mislead the L14 lesson).
//   - local PCs = number of registered PairContexts (one per remote
//     peer). Equals `N − 1` once everyone is paired (FR-070, US1 AS#2).
//   - local DCs = `local PCs` (M6 created one DataChannel per PC even
//     before chat lands, so the cost stays honest about the data
//     m-line we negotiated; FR-050).
//   - outgoing audio senders = local PCs (one audio track per pair).
//   - outgoing video senders = local PCs (one video track per pair).
//   - room-wide pair total = `N × (N − 1) / 2` — the FR-070 / NFR-007
//     "O(N²)" surface.
//   - connected / connecting / failed pair counts derived from each
//     PairView's `connectionState`.

import type { MeshLocalParticipant } from "./local";
import type { MeshRosterSlice } from "./roster";
import type { MeshPairsSlice, MeshPairView } from "./pairs";

export interface MeshCostSummary {
  readonly participants: number;
  readonly localPeerCount: number;
  readonly localPeerConnectionCount: number;
  readonly localDataChannelCount: number;
  readonly outgoingAudioSenderCount: number;
  readonly outgoingVideoSenderCount: number;
  readonly outgoingSenderCount: number;
  readonly totalRoomPairCount: number;
  readonly connectedPairCount: number;
  readonly connectingPairCount: number;
  readonly failedPairCount: number;
  readonly pendingPairCount: number;
}

export function computeMeshCost(input: {
  local: MeshLocalParticipant;
  roster: MeshRosterSlice;
  pairs: MeshPairsSlice;
}): MeshCostSummary {
  const remoteCount = Object.keys(input.roster.byPeerId).length;
  // Count local participant only once the local user is admitted.
  // `joined` is sufficient — admissionIndex is assigned then.
  const localCounted = isLocalAdmitted(input.local) ? 1 : 0;
  const participants = remoteCount + localCounted;
  const totalRoomPairCount = (participants * (participants - 1)) / 2;

  const pairs = Object.values(input.pairs.byPairId);
  const localPeerConnectionCount = pairs.length;
  const localDataChannelCount = pairs.length;
  const outgoingAudioSenderCount = pairs.length;
  const outgoingVideoSenderCount = pairs.length;
  const outgoingSenderCount =
    outgoingAudioSenderCount + outgoingVideoSenderCount;

  let connected = 0;
  let connecting = 0;
  let failed = 0;
  let pending = 0;
  for (const p of pairs) {
    switch (categorizePair(p)) {
      case "connected":
        connected++;
        break;
      case "connecting":
        connecting++;
        break;
      case "failed":
        failed++;
        break;
      default:
        pending++;
    }
  }

  return {
    participants,
    localPeerCount: localPeerConnectionCount,
    localPeerConnectionCount,
    localDataChannelCount,
    outgoingAudioSenderCount,
    outgoingVideoSenderCount,
    outgoingSenderCount,
    totalRoomPairCount,
    connectedPairCount: connected,
    connectingPairCount: connecting,
    failedPairCount: failed,
    pendingPairCount: pending,
  };
}

function isLocalAdmitted(local: MeshLocalParticipant): boolean {
  switch (local.fsm) {
    case "joined":
    case "acquiring-media":
    case "media-ready":
    case "in-room":
    case "leaving":
      return true;
    default:
      return false;
  }
}

type PairCategory = "connected" | "connecting" | "failed" | "pending";

function categorizePair(p: MeshPairView): PairCategory {
  switch (p.connectionState) {
    case "connected":
      return "connected";
    case "failed":
    case "disconnected":
    case "closed":
      return "failed";
    case "connecting":
      return "connecting";
    default:
      return "pending";
  }
}
