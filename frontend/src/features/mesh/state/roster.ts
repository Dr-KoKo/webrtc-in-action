// Mesh roster slice (data-model §B.2). Holds remote participants only
// — the local participant lives in `./local.ts`. Inputs:
//
//   - `mesh_roster_snapshot` (§3.4) — replaces `byPeerId`, sets `serverSeq`.
//   - `mesh_roster_update`   (§3.5) — applies iff `payload.serverSeq > state.serverSeq`,
//                                     else dropped (the dispatcher logs the drop).
//                                     `released` / `left` removes the entry.
//
// Out-of-order updates (`payload.serverSeq <= state.serverSeq`) are
// dropped silently from the reducer's perspective; the dispatcher
// records them in the event log as `mesh_roster_update_dropped_stale`
// (data-model §A.6, contract §3.5).

import type { Presence } from "../signaling/schema";

export interface RemoteParticipant {
  readonly peerId: string;
  readonly admissionIndex: number;
  readonly presence: Presence;
  readonly joinedAt?: number;
}

export interface MeshRosterSlice {
  readonly serverSeq: number;
  readonly byPeerId: Readonly<Record<string, RemoteParticipant>>;
}

export const initialMeshRosterSlice: MeshRosterSlice = {
  serverSeq: 0,
  byPeerId: {},
};

export type MeshRosterAction =
  | {
      type: "MESH_ROSTER_SNAPSHOT_APPLIED";
      serverSeq: number;
      participants: ReadonlyArray<{
        peerId: string;
        admissionIndex: number;
        presence: Presence;
      }>;
      // peerId of the local participant; excluded from byPeerId so the
      // `Roster` slice contains REMOTE participants only.
      selfPeerId?: string;
      now?: number;
    }
  | {
      type: "MESH_ROSTER_UPDATE_APPLIED";
      serverSeq: number;
      subjectPeerId: string;
      admissionIndex: number;
      presence: Presence;
      selfPeerId?: string;
      now?: number;
    }
  | { type: "MESH_ROSTER_RESET" };

export type MeshRosterReducerOutcome =
  | { kind: "applied"; next: MeshRosterSlice }
  | { kind: "dropped-stale"; next: MeshRosterSlice }
  | { kind: "dropped-invalid"; next: MeshRosterSlice; reason: string };

export function meshRosterReducer(
  state: MeshRosterSlice,
  action: MeshRosterAction,
): MeshRosterSlice {
  return rosterReducerWithOutcome(state, action).next;
}

// Returns a richer outcome so the dispatcher can log dropped frames as
// `mesh_roster_update_dropped_stale` event entries. Pure: never
// throws; returns the same slice when the update is dropped so React
// re-renders are avoided.
export function rosterReducerWithOutcome(
  state: MeshRosterSlice,
  action: MeshRosterAction,
): MeshRosterReducerOutcome {
  switch (action.type) {
    case "MESH_ROSTER_SNAPSHOT_APPLIED": {
      const byPeerId: Record<string, RemoteParticipant> = {};
      const ts = action.now ?? Date.now();
      for (const p of action.participants) {
        if (action.selfPeerId && p.peerId === action.selfPeerId) continue;
        byPeerId[p.peerId] = {
          peerId: p.peerId,
          admissionIndex: p.admissionIndex,
          presence: p.presence,
          joinedAt: ts,
        };
      }
      return {
        kind: "applied",
        next: {
          serverSeq: action.serverSeq,
          byPeerId,
        },
      };
    }
    case "MESH_ROSTER_UPDATE_APPLIED": {
      if (action.serverSeq <= state.serverSeq) {
        return { kind: "dropped-stale", next: state };
      }
      // Local participant updates do not appear in the roster slice;
      // they are mirrored in `LocalParticipant`. Bump serverSeq either
      // way so the next remote update is correctly ordered.
      if (action.selfPeerId && action.subjectPeerId === action.selfPeerId) {
        return {
          kind: "applied",
          next: { ...state, serverSeq: action.serverSeq },
        };
      }
      const isRemoval =
        action.presence === "released" || action.presence === "left";
      const next: Record<string, RemoteParticipant> = { ...state.byPeerId };
      if (isRemoval) {
        delete next[action.subjectPeerId];
      } else {
        const existing = next[action.subjectPeerId];
        next[action.subjectPeerId] = {
          peerId: action.subjectPeerId,
          admissionIndex: action.admissionIndex,
          presence: action.presence,
          joinedAt: existing?.joinedAt ?? action.now ?? Date.now(),
        };
      }
      return {
        kind: "applied",
        next: { serverSeq: action.serverSeq, byPeerId: next },
      };
    }
    case "MESH_ROSTER_RESET":
      return { kind: "applied", next: initialMeshRosterSlice };
    default:
      return { kind: "applied", next: state };
  }
}

export function selectRosterAsArray(
  slice: MeshRosterSlice,
): RemoteParticipant[] {
  return Object.values(slice.byPeerId).sort(
    (a, b) => a.admissionIndex - b.admissionIndex,
  );
}
