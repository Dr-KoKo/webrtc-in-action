// Mesh event-log slice (data-model §B.6). Bounded ring buffer of
// `EventEntry` records used by `MeshEventLogPanel`. Entries are
// classified by `scope`:
//
//   - room  — applies to the whole room (transport up/down, snapshot).
//   - peer  — applies to a single remote participant; MUST carry peerId.
//   - pair  — applies to a single pair; MUST carry both peerId + pairId.
//   - local — applies to the local user (media-error, signaling-error).
//
// FR-061 invariant: every `peer` / `pair` entry carries `peerId` (and
// `pairId` for pair scope). The reducer enforces this by accepting an
// already-validated entry — callers (e.g. dispatcher.ts) assemble the
// entry through `makeMeshEventEntry()` which keeps the contract
// closed.

export const MESH_EVENT_LOG_CAPACITY = 1000;

export type MeshEventScope = "room" | "peer" | "pair" | "local";

export type MeshEventType =
  // transport
  | "signaling_connecting"
  | "signaling_connected"
  | "signaling_disconnected"
  | "signaling_error"
  // admission
  | "join_room_sent"
  | "join_accepted"
  | "join_rejected"
  | "participant_released"
  // roster
  | "mesh_roster_snapshot_received"
  | "mesh_roster_update_applied"
  | "mesh_roster_update_dropped_stale"
  | "mesh_roster_update_dropped_invalid"
  // media (M5)
  | "media_acquire_started"
  | "media_ready_sent"
  | "media_failed_sent"
  | "media_error_local"
  | "retry_requested"
  // generic
  | "error_occurred"
  // future-phase pass-through (logged, not state-mutating)
  | "future_phase_message";

export interface MeshEventEntry {
  readonly id: string;
  readonly ts: number;
  readonly scope: MeshEventScope;
  readonly type: MeshEventType;
  readonly summary: string;
  readonly peerId?: string;
  readonly pairId?: string;
  readonly detail?: Record<string, unknown>;
}

export interface MeshEventLogSlice {
  readonly entries: readonly MeshEventEntry[];
}

export const initialMeshEventLogSlice: MeshEventLogSlice = {
  entries: [],
};

export type MeshEventLogAction =
  | { type: "MESH_EVENT_APPEND"; entry: MeshEventEntry }
  | { type: "MESH_EVENT_LOG_RESET" };

let meshEventSeq = 0;

export function makeMeshEventEntry(
  init: Omit<MeshEventEntry, "id" | "ts"> & { ts?: number; id?: string },
): MeshEventEntry {
  if (
    (init.scope === "peer" || init.scope === "pair") &&
    !init.peerId
  ) {
    throw new Error(
      `mesh event entry of scope=${init.scope} requires peerId (FR-061)`,
    );
  }
  if (init.scope === "pair" && !init.pairId) {
    throw new Error("mesh event entry of scope=pair requires pairId (FR-061)");
  }
  meshEventSeq += 1;
  return {
    id: init.id ?? `mevt-${Date.now().toString(36)}-${meshEventSeq}`,
    ts: init.ts ?? Date.now(),
    scope: init.scope,
    type: init.type,
    summary: init.summary,
    ...(init.peerId !== undefined ? { peerId: init.peerId } : {}),
    ...(init.pairId !== undefined ? { pairId: init.pairId } : {}),
    ...(init.detail !== undefined ? { detail: init.detail } : {}),
  };
}

export function __resetMeshEventLogSequence(): void {
  meshEventSeq = 0;
}

export function meshEventLogReducer(
  state: MeshEventLogSlice,
  action: MeshEventLogAction,
): MeshEventLogSlice {
  switch (action.type) {
    case "MESH_EVENT_APPEND": {
      const next = [...state.entries, action.entry];
      if (next.length > MESH_EVENT_LOG_CAPACITY) {
        next.splice(0, next.length - MESH_EVENT_LOG_CAPACITY);
      }
      return { entries: next };
    }
    case "MESH_EVENT_LOG_RESET":
      return initialMeshEventLogSlice;
    default:
      return state;
  }
}

// Selectors. Kept here so `MeshEventLogPanel` and tests share identical
// filter logic.

export function selectAll(state: MeshEventLogSlice): readonly MeshEventEntry[] {
  return state.entries;
}

export function selectByPeer(
  state: MeshEventLogSlice,
  peerId: string,
): MeshEventEntry[] {
  return state.entries.filter((e) => e.peerId === peerId);
}

export function selectByPair(
  state: MeshEventLogSlice,
  pairId: string,
): MeshEventEntry[] {
  return state.entries.filter((e) => e.pairId === pairId);
}

export function selectRoomScope(
  state: MeshEventLogSlice,
): MeshEventEntry[] {
  return state.entries.filter((e) => e.scope === "room");
}
