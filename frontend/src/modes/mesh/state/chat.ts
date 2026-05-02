// Mesh chat slice (data-model §B.5 / FR-051..FR-055 / L17).
//
// One `ChatState` lives at the root mesh store. `messages` holds every
// chat entry the local user can see — local echo (one per outgoing
// send, FR-052a) and inbound entries (one per incoming DataChannel
// message, FR-051). `fanOutByMessageId` records the per-message
// delivery summary that the sender UI displays
// (`<succeeded> / <attempted> delivered`).
//
// This slice is intentionally pure: callers (MeshChat component +
// dataChannel receivers) compute IDs and timestamps and pass them in.
// That keeps the reducer trivial to test and keeps "where did this id
// come from" close to the call site.

import type { DataChannelDisplayState } from "./pairs";

export interface MeshChatMessage {
  readonly id: string;
  readonly authorPeerId: string;
  readonly text: string;
  // sender clock (ms since epoch). Set on outgoing send and copied
  // through from the wire payload on inbound messages.
  readonly sentAt?: number;
  // recipient clock (ms since epoch). Set when the inbound DataChannel
  // message arrives. Absent on outgoing local echo entries.
  readonly receivedAt?: number;
}

export interface MeshChatSkippedPeer {
  readonly remotePeerId: string;
  readonly pairId: string;
  readonly reason: "datachannel_not_open";
  readonly readyState: DataChannelDisplayState;
}

export interface MeshChatFanOut {
  readonly messageId: string;
  // |PairMap| at the time of send (data-model §B.5).
  readonly attempted: number;
  readonly succeeded: number;
  readonly skipped: readonly MeshChatSkippedPeer[];
}

export type MeshChatValidationReason = "empty" | "too_long";

export interface MeshChatValidationError {
  readonly reason: MeshChatValidationReason;
  readonly attemptedAt: number;
  readonly textLength: number;
}

export interface MeshChatSlice {
  readonly messages: readonly MeshChatMessage[];
  readonly fanOutByMessageId: Readonly<Record<string, MeshChatFanOut>>;
  readonly lastValidationError: MeshChatValidationError | null;
}

export const MESH_CHAT_MAX_LEN = 500;

export const initialMeshChatSlice: MeshChatSlice = {
  messages: [],
  fanOutByMessageId: {},
  lastValidationError: null,
};

export type MeshChatAction =
  | {
      type: "MESH_CHAT_LOCAL_APPENDED";
      message: MeshChatMessage;
      fanOut: MeshChatFanOut;
    }
  | { type: "MESH_CHAT_INBOUND_APPENDED"; message: MeshChatMessage }
  | {
      type: "MESH_CHAT_VALIDATION_FAILED";
      reason: MeshChatValidationReason;
      attemptedAt: number;
      textLength: number;
    }
  | { type: "MESH_CHAT_VALIDATION_CLEARED" }
  | { type: "MESH_CHAT_RESET" };

export function meshChatReducer(
  state: MeshChatSlice,
  action: MeshChatAction,
): MeshChatSlice {
  switch (action.type) {
    case "MESH_CHAT_LOCAL_APPENDED": {
      // Idempotent on `messageId` — a duplicate dispatch (e.g. a UI
      // double-bind firing onSubmit twice) MUST NOT push two echo
      // entries (FR-052a). We treat the first dispatch as canonical.
      if (state.fanOutByMessageId[action.fanOut.messageId]) return state;
      return {
        ...state,
        messages: [...state.messages, action.message],
        fanOutByMessageId: {
          ...state.fanOutByMessageId,
          [action.fanOut.messageId]: action.fanOut,
        },
        lastValidationError: null,
      };
    }
    case "MESH_CHAT_INBOUND_APPENDED": {
      // Per-channel ordering only (FR-055). We append in arrival order,
      // do NOT attempt to reorder by `sentAt`, and do NOT deduplicate
      // across senders. The receiver dataChannel registration is
      // idempotent at the dc-instance level (see attachMeshChatReceiver
      // in webrtc/dataChannel.ts) so each inbound DataChannel message
      // produces exactly one append here.
      return {
        ...state,
        messages: [...state.messages, action.message],
      };
    }
    case "MESH_CHAT_VALIDATION_FAILED": {
      return {
        ...state,
        lastValidationError: {
          reason: action.reason,
          attemptedAt: action.attemptedAt,
          textLength: action.textLength,
        },
      };
    }
    case "MESH_CHAT_VALIDATION_CLEARED": {
      if (state.lastValidationError === null) return state;
      return { ...state, lastValidationError: null };
    }
    case "MESH_CHAT_RESET":
      return initialMeshChatSlice;
    default:
      return state;
  }
}

export function selectChatMessages(
  slice: MeshChatSlice,
): readonly MeshChatMessage[] {
  return slice.messages;
}

export function selectFanOut(
  slice: MeshChatSlice,
  messageId: string,
): MeshChatFanOut | undefined {
  return slice.fanOutByMessageId[messageId];
}

// Pure validation helper used by both the UI and tests so the
// "trim → empty / too-long" semantics live in one place.
export type MeshChatValidationResult =
  | { ok: true; trimmed: string }
  | { ok: false; reason: MeshChatValidationReason; trimmed: string };

export function validateMeshChatInput(
  raw: string,
): MeshChatValidationResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "empty", trimmed };
  }
  if (trimmed.length > MESH_CHAT_MAX_LEN) {
    return { ok: false, reason: "too_long", trimmed };
  }
  return { ok: true, trimmed };
}
