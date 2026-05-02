// Per-mode event-log helper for mesh (Phase F4 of the frontend rings
// refactor). Promotes the private `appendEvent` closure inside
// pairManager.ts to a top-level module so all mesh callers share one
// helper.
//
// Mesh event entries carry a 4-element `scope` (room | peer | pair |
// local) plus optional peerId/pairId/detail. The four convenience
// methods below pre-fill `scope` and require the matching identifiers
// at the type level — so a typo like `log.peer({ ... pairId })` is
// caught at compile time.
//
// Two construction modes:
//
//   makeMeshLog((entry) => store.getState().dispatch({type:"MESH_EVENT_APPEND", entry}))
//     — for non-React verbs (Phase F5), where the caller holds a
//       store API directly.
//
//   useMeshLog()
//     — React-hook form; internally builds the helper from
//       useMeshDispatch(). Used by components and the legacy provider
//       tower until subsequent phases migrate them.

import { useMemo } from "react";
import {
  makeMeshEventEntry,
  type MeshEventEntry,
  type MeshEventScope,
  type MeshEventType,
} from "../state/eventLog";
import { useMeshDispatch } from "../state";

export type MeshLogPayload = {
  type: MeshEventType;
  summary: string;
  detail?: Record<string, unknown>;
};

export type MeshPairLogPayload = MeshLogPayload & {
  peerId: string;
  pairId: string;
};

export type MeshPeerLogPayload = MeshLogPayload & {
  peerId: string;
};

export interface MeshLog {
  room(payload: MeshLogPayload): void;
  peer(payload: MeshPeerLogPayload): void;
  pair(payload: MeshPairLogPayload): void;
  local(payload: MeshLogPayload): void;
}

export function makeMeshLog(
  append: (entry: MeshEventEntry) => void,
): MeshLog {
  const emit = (
    scope: MeshEventScope,
    payload: MeshLogPayload & { peerId?: string; pairId?: string },
  ): void =>
    append(
      makeMeshEventEntry({
        scope,
        type: payload.type,
        summary: payload.summary,
        ...(payload.peerId !== undefined ? { peerId: payload.peerId } : {}),
        ...(payload.pairId !== undefined ? { pairId: payload.pairId } : {}),
        ...(payload.detail !== undefined ? { detail: payload.detail } : {}),
      }),
    );
  return {
    room: (p) => emit("room", p),
    peer: (p) => emit("peer", p),
    pair: (p) => emit("pair", p),
    local: (p) => emit("local", p),
  };
}

export function useMeshLog(): MeshLog {
  const dispatch = useMeshDispatch();
  return useMemo(
    () =>
      makeMeshLog((entry) =>
        dispatch({ type: "MESH_EVENT_APPEND", entry }),
      ),
    [dispatch],
  );
}
