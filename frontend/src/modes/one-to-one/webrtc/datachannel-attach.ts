// DataChannel attachment helper (Phase D1).
//
// Wraps a browser RTCDataChannel (offerer-created or answerer-received)
// and routes its lifecycle + inbound messages into the store. Called
// twice per pairing at most: once from the offerer's
// `createChatDataChannel` result, once from the answerer's
// `ondatachannel` event. The `origin` label narrates whether this side
// created or received the channel — it does NOT split the code path.

import {
  makeChatMessage,
  validateChatMessage,
} from "../state/chat";
import {
  wrapDataChannel,
  type DataChannelStateValue,
} from "./data-channel";
import type { OneToOneCtx } from "./ctx";

export function attachChatDataChannel(
  ctx: OneToOneCtx,
  channel: RTCDataChannel,
  origin: "offerer" | "answerer",
): void {
  const { refs, log, store } = ctx;
  // Idempotence guard: replace any prior wrapper defensively.
  const existing = refs.chatChannel.current;
  if (existing) {
    existing.close();
    refs.chatChannel.current = null;
  }
  const wrapper = wrapDataChannel({
    channel,
    onStateChange: (next: DataChannelStateValue) => {
      store.getState().setDataChannelState(next);
      log.datachannel({
        type: "data_channel_state_changed",
        direction: origin === "offerer" ? "local" : "remote",
        summary: `dataChannel("${channel.label}") → ${next}`,
      });
    },
    onMessage: (data: unknown) => {
      const result = validateChatMessage(data);
      if (!result.ok) {
        log.datachannel({
          type: "data_channel_error",
          direction: "remote",
          summary: `chat message rejected (${result.reason})`,
          code: `chat_invalid_${result.reason}`,
        });
        return;
      }
      const message = makeChatMessage({ from: "peer", text: result.text });
      store.getState().appendChatMessage(message);
      log.datachannel({
        type: "chat_message_received",
        direction: "remote",
        summary: `chat received: ${summarizeChatText(result.text)}`,
      });
    },
    onError: (ev: Event) => {
      const errorEv = ev as RTCErrorEvent;
      const detail =
        errorEv && errorEv.error && errorEv.error.message
          ? errorEv.error.message
          : "unknown";
      log.datachannel({
        type: "data_channel_error",
        direction: "system",
        summary: `dataChannel error: ${detail}`,
        code: "data_channel_error",
      });
    },
  });
  refs.chatChannel.current = wrapper;
}

function summarizeChatText(text: string): string {
  const limit = 80;
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
