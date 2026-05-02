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

import type {
  CameraState,
  MicState,
  Presence,
  ScreenShareState,
} from "../signaling/schema";

// RemoteMediaState — last `pair_media_state` snapshot received for the
// peer (M9 / FR-033). Until the first message arrives, every field is
// the contract's "unknown" default — mic+camera "on", screen-share
// "inactive" — so the indicators don't render an alarmist "muted"
// state for peers that simply haven't toggled yet.
export interface RemoteMediaState {
  readonly microphone: MicState;
  readonly camera: CameraState;
  readonly screenShare: ScreenShareState;
  readonly receivedAt?: number;
}

export const defaultRemoteMediaState: RemoteMediaState = {
  microphone: "on",
  camera: "on",
  screenShare: "inactive",
};

export interface RemoteParticipant {
  readonly peerId: string;
  readonly admissionIndex: number;
  readonly presence: Presence;
  readonly joinedAt?: number;
  readonly remoteMedia: RemoteMediaState;
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
  | {
      // Server-fanned-out `pair_media_state` (M9 / contract §3.13).
      // Updates only the named remote peer's `remoteMedia`. NEVER
      // touches the local participant or any other roster entry.
      type: "MESH_REMOTE_MEDIA_STATE_APPLIED";
      subjectPeerId: string;
      microphone: MicState;
      camera: CameraState;
      screenShare: ScreenShareState;
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
          remoteMedia: defaultRemoteMediaState,
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
          remoteMedia: existing?.remoteMedia ?? defaultRemoteMediaState,
        };
      }
      return {
        kind: "applied",
        next: { serverSeq: action.serverSeq, byPeerId: next },
      };
    }
    case "MESH_REMOTE_MEDIA_STATE_APPLIED": {
      // Drop silently if the subject peer is unknown — the dispatcher
      // surfaces the unknown-sender case as an error event so the
      // reducer doesn't need to log here. This keeps the reducer pure
      // (no console / event-log side effects) and matches the
      // "unknown sender → safe no-op" requirement (T072 testing).
      const existing = state.byPeerId[action.subjectPeerId];
      if (!existing) {
        return { kind: "applied", next: state };
      }
      const ts = action.now ?? Date.now();
      const next: Record<string, RemoteParticipant> = {
        ...state.byPeerId,
        [action.subjectPeerId]: {
          ...existing,
          remoteMedia: {
            microphone: action.microphone,
            camera: action.camera,
            screenShare: action.screenShare,
            receivedAt: ts,
          },
        },
      };
      return {
        kind: "applied",
        next: { serverSeq: state.serverSeq, byPeerId: next },
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
