// Local-participant slice (data-model §B.1). The mesh local FSM is
// strictly distinct from the 001 session reducer (Spec FR-013a, plan
// §9): no shared state, no shared actions. Three state surfaces are
// held separate: `LocalParticipant` (here), `Roster` (`./roster.ts`),
// and `PairMap` (M6+).
//
// FSM transitions implemented in M4 + M5:
//
//   idle ──JOIN_REQUESTED──▶ joining
//                              │
//                              ├ JOIN_ACCEPTED ──▶ joined ──MEDIA_ACQUIRE_STARTED──▶ acquiring-media
//                              │                            ├ MEDIA_READY ──▶ media-ready
//                              │                            └ MEDIA_FAILED ──▶ media-error
//                              └ JOIN_REJECTED ──▶ idle (with banner)
//
//   media-error ──RETRY_REQUESTED──▶ acquiring-media (retry without page reload)
//
//   (any) ──SIGNALING_CLOSED while admitted──▶ signaling-error
//
// M12 Path A (graceful Leave) — data-model §C.3:
//
//   (admitted) ──LEAVE_REQUESTED──▶ leaving ──LEAVE_COMPLETED──▶ left
//
// `left` is a terminal-for-this-admission state. The route shell may
// reset to `idle` to return the user to the lobby (MESH_LOCAL_RESET).
//
// `in-room`, `leaving`, `left`, `released`, `failed` are reserved for
// later milestones (M6+ pair lifecycle, M11 cleanup); the action space
// is left open here so the dispatcher can extend without re-typing the
// FSM.

import type { MeshTransportState } from "../signaling/client";

export type MeshLocalFsm =
  | "idle"
  | "joining"
  | "joined"
  | "acquiring-media"
  | "media-ready"
  | "media-error"
  | "in-room"
  | "leaving"
  | "left"
  | "released"
  | "failed"
  | "signaling-error";

export interface MeshLocalErrorBanner {
  readonly kind: "media-error" | "signaling-error" | "join-rejected";
  readonly detail?: string;
}

export interface MeshLocalParticipant {
  readonly fsm: MeshLocalFsm;
  readonly roomId?: string;
  readonly peerId?: string;
  readonly admissionIndex?: number;
  readonly signalingTransport: MeshTransportState;
  readonly errorBanner?: MeshLocalErrorBanner;
}

export const initialMeshLocalParticipant: MeshLocalParticipant = {
  fsm: "idle",
  signalingTransport: "idle",
};

export type MeshLocalAction =
  | { type: "MESH_JOIN_REQUESTED"; roomId: string }
  | {
      type: "MESH_JOIN_ACCEPTED";
      peerId: string;
      admissionIndex: number;
    }
  | {
      type: "MESH_JOIN_REJECTED";
      result: "join_rejected_room_full" | "join_rejected_invalid_room";
      message: string;
    }
  | { type: "MESH_MEDIA_ACQUIRE_STARTED" }
  | { type: "MESH_MEDIA_READY" }
  | { type: "MESH_MEDIA_FAILED"; detail?: string }
  | { type: "MESH_RETRY_REQUESTED" }
  | { type: "MESH_PARTICIPANT_RELEASED"; detail?: string }
  | { type: "MESH_TRANSPORT_CHANGED"; transport: MeshTransportState }
  | { type: "MESH_LEAVE_REQUESTED" }
  | { type: "MESH_LEAVE_COMPLETED" }
  | { type: "MESH_LOCAL_RESET" };

export function meshLocalReducer(
  state: MeshLocalParticipant,
  action: MeshLocalAction,
): MeshLocalParticipant {
  switch (action.type) {
    case "MESH_JOIN_REQUESTED": {
      if (state.fsm !== "idle" && state.fsm !== "media-error") return state;
      const { errorBanner: _drop, ...rest } = state;
      return {
        ...rest,
        fsm: "joining",
        roomId: action.roomId,
      };
    }
    case "MESH_JOIN_ACCEPTED": {
      if (state.fsm !== "joining") return state;
      return {
        ...state,
        fsm: "joined",
        peerId: action.peerId,
        admissionIndex: action.admissionIndex,
      };
    }
    case "MESH_JOIN_REJECTED": {
      if (state.fsm !== "joining") return state;
      return {
        ...initialMeshLocalParticipant,
        signalingTransport: state.signalingTransport,
        errorBanner: { kind: "join-rejected", detail: action.message },
      } satisfies MeshLocalParticipant;
    }
    case "MESH_MEDIA_ACQUIRE_STARTED": {
      // Allowed from `joined` (initial flow) or `media-error` (retry).
      if (state.fsm !== "joined" && state.fsm !== "media-error") return state;
      const { errorBanner: _drop, ...rest } = state;
      return { ...rest, fsm: "acquiring-media" };
    }
    case "MESH_MEDIA_READY": {
      if (state.fsm !== "acquiring-media") return state;
      return { ...state, fsm: "media-ready" };
    }
    case "MESH_MEDIA_FAILED": {
      // Allowed from `acquiring-media`; reaching `media-error` puts the
      // user in the retry-able banner state.
      if (state.fsm !== "acquiring-media") return state;
      return {
        ...state,
        fsm: "media-error",
        errorBanner: {
          kind: "media-error",
          ...(action.detail !== undefined ? { detail: action.detail } : {}),
        },
      };
    }
    case "MESH_RETRY_REQUESTED": {
      // Transition `media-error → joined` so the media controller's
      // join-driven effect re-runs `getUserMedia`. Banner cleared.
      if (state.fsm !== "media-error") return state;
      const { errorBanner: _drop, ...rest } = state;
      return { ...rest, fsm: "joined" };
    }
    case "MESH_PARTICIPANT_RELEASED": {
      // Server signaled release of own slot. After this, the local
      // user sees the media-error banner and may retry (data-model
      // §C.4). M5: server only emits participant_released from
      // handleMediaFailed, so post-media-ready states are unreachable
      // — guard them so a stray message can't null a live stream
      // mid-call. Extend this guard when M11 introduces
      // server-initiated releases (pair-failure / kick semantics).
      if (
        state.fsm !== "joined" &&
        state.fsm !== "acquiring-media" &&
        state.fsm !== "media-error"
      ) {
        return state;
      }
      return {
        ...state,
        fsm: "released",
        errorBanner: {
          kind: "media-error",
          ...(action.detail !== undefined ? { detail: action.detail } : {}),
        },
      };
    }
    case "MESH_LEAVE_REQUESTED": {
      // Idempotent: a second click while leaving / already-left is a
      // no-op. From `idle` (never joined) we have nothing to leave;
      // also treat as no-op.
      if (
        state.fsm === "idle" ||
        state.fsm === "leaving" ||
        state.fsm === "left"
      ) {
        return state;
      }
      const { errorBanner: _drop, ...rest } = state;
      return { ...rest, fsm: "leaving" };
    }
    case "MESH_LEAVE_COMPLETED": {
      // Allowed only from leaving; ignore stray completions so a
      // stale teardown can't drop us out of an active session.
      if (state.fsm !== "leaving") return state;
      return {
        ...initialMeshLocalParticipant,
        signalingTransport: state.signalingTransport,
        fsm: "left",
      };
    }
    case "MESH_TRANSPORT_CHANGED": {
      const lostTransport =
        action.transport === "closed" || action.transport === "error";
      const midSession =
        state.fsm !== "idle" &&
        state.fsm !== "left" &&
        state.fsm !== "leaving" &&
        state.fsm !== "signaling-error";
      if (lostTransport && midSession) {
        return {
          ...state,
          fsm: "signaling-error",
          signalingTransport: action.transport,
          errorBanner: {
            kind: "signaling-error",
            detail: "signaling connection lost",
          },
        };
      }
      return { ...state, signalingTransport: action.transport };
    }
    case "MESH_LOCAL_RESET":
      return initialMeshLocalParticipant;
    default:
      return state;
  }
}
