// Chat-send verb (Phase D1) — Phase 9 (T068).
//
// Pure validation first (same rule used at receive time), then route
// the bytes through the live RTCDataChannel wrapper. Every failure
// path produces one event-log entry; success appends to the chat
// transcript AND emits one event-log entry.

import {
  makeChatMessage,
  validateChatMessage,
  type ChatValidationError,
} from "../state/chat";
import type { OneToOneCtx } from "./ctx";
import type { ChatSendResult } from "./data-channel";

export type ChatSendOutcome =
  | { ok: true }
  | { ok: false; reason: ChatSendError };

export type ChatSendError =
  | ChatValidationError
  | "not-open"
  | "backpressure"
  | "invalid";

export function sendChatMessage(
  ctx: OneToOneCtx,
  rawInput: string,
): ChatSendOutcome {
  const { refs, log, store } = ctx;
  const validation = validateChatMessage(rawInput);
  if (!validation.ok) {
    log.datachannel({
      type: "data_channel_error",
      direction: "local",
      summary: `chat send rejected (${validation.reason})`,
      code: `chat_invalid_${validation.reason}`,
    });
    return { ok: false, reason: validation.reason };
  }
  const wrapper = refs.chatChannel.current;
  if (!wrapper) {
    log.datachannel({
      type: "data_channel_error",
      direction: "local",
      summary: "chat send rejected (no active DataChannel)",
      code: "chat_send_no_channel",
    });
    return { ok: false, reason: "not-open" };
  }
  const sendResult: ChatSendResult = wrapper.send(validation.text);
  if (!sendResult.ok) {
    log.datachannel({
      type: "data_channel_error",
      direction: "local",
      summary: `chat send failed (${sendResult.reason})`,
      code: `chat_send_${sendResult.reason}`,
    });
    return { ok: false, reason: sendResult.reason };
  }
  const message = makeChatMessage({ from: "self", text: validation.text });
  store.getState().appendChatMessage(message);
  log.datachannel({
    type: "chat_message_sent",
    direction: "local",
    summary: `chat sent: ${summarizeChatText(validation.text)}`,
  });
  return { ok: true };
}

function summarizeChatText(text: string): string {
  const limit = 80;
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
