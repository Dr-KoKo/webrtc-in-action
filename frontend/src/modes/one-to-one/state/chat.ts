// Chat slice + validation — Phase 9 (T068, data-model §B.8).
//
// FR-015a: chat text must be trimmed, non-empty, and ≤500 characters.
// NFR-006 + constitution Principle VIII: render as plain text only;
// never inject HTML. Validation is a pure function used both on send
// (before handing bytes to `RTCDataChannel.send`) and on receive
// (before appending to the transcript) — defense in depth.
//
// `ChatMessage.transport` is fixed to `"datachannel"` in this phase.
// The spec reserves `"signaling"` for an optional didactic interim
// (Phase 9a), which is NOT scheduled as a task; if that path ever
// lands it will widen the literal type in lockstep.

export const CHAT_MAX_LENGTH = 500;

export type ChatValidationError = "not-string" | "empty" | "too-long";

export type ChatValidationResult =
  | { ok: true; text: string }
  | { ok: false; reason: ChatValidationError };

/**
 * Validate a prospective chat message. The caller is expected to pass
 * `unknown` at boundaries (inbound DataChannel frames are `unknown`
 * until validated). Trimmed whitespace is the canonical form stored
 * and rendered; the original input is never kept.
 */
export function validateChatMessage(input: unknown): ChatValidationResult {
  if (typeof input !== "string") {
    return { ok: false, reason: "not-string" };
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "empty" };
  }
  if (trimmed.length > CHAT_MAX_LENGTH) {
    return { ok: false, reason: "too-long" };
  }
  return { ok: true, text: trimmed };
}

export interface ChatMessage {
  readonly id: string;
  readonly from: "self" | "peer";
  readonly text: string;
  readonly ts: number;
  readonly transport: "datachannel";
}

export interface ChatSlice {
  readonly messages: readonly ChatMessage[];
}

export const initialChatSlice: ChatSlice = {
  messages: [],
};

export type ChatAction =
  | { type: "CHAT_MESSAGE_APPENDED"; message: ChatMessage }
  | { type: "CHAT_CLEARED" };

let chatSequence = 0;
// Deterministic id — monotonic counter + timestamp, same scheme as
// event-log entries. Used for React keys and for tests that pin
// transcript ordering.
export function makeChatMessage(
  init: Omit<ChatMessage, "id" | "ts" | "transport"> & {
    ts?: number;
    id?: string;
  },
): ChatMessage {
  chatSequence += 1;
  return {
    id: init.id ?? `chat-${Date.now().toString(36)}-${chatSequence}`,
    ts: init.ts ?? Date.now(),
    from: init.from,
    text: init.text,
    transport: "datachannel",
  };
}

export function __resetChatSequence(): void {
  chatSequence = 0;
}

export function chatReducer(state: ChatSlice, action: ChatAction): ChatSlice {
  switch (action.type) {
    case "CHAT_MESSAGE_APPENDED":
      return { messages: [...state.messages, action.message] };
    case "CHAT_CLEARED":
      return initialChatSlice;
    default: {
      const _exhaustive: never = action;
      void _exhaustive;
      return state;
    }
  }
}
