// RTCDataChannel wrapper — Phase 9 (T064, data-model §B.5).
//
// Centralizes attach-listeners + send-with-backpressure for the chat
// DataChannel. Keeps the browser object out of reducer state — the
// `RTCDataChannel` itself lives in a ref owned by the provider; this
// module only exposes a narrow surface that is safe to call from UI
// code (send, close) or to subscribe to via callbacks.
//
// Scope (Phase 9):
// - Observe `open` / `close` / `closing` / `error` and surface them as
//   a `DataChannelStateValue` stream (maps 1:1 to `readyState`).
// - Observe inbound `message` events; strings only — non-string frames
//   are rejected (spec NFR-006 keeps chat text-only).
// - Send text with a `bufferedAmount` ceiling so a user spamming the
//   input can't exhaust the browser's per-channel send buffer.
// - Idempotent close; safe to call even after the channel is already
//   closed by the peer.
//
// The wrapper is deliberately pure — no React, no reducer, no
// signaling. Providers wire it to the reducer via the callbacks.

export type DataChannelStateValue =
  | "absent"
  | "connecting"
  | "open"
  | "closing"
  | "closed";

export type ChatSendResult =
  | { ok: true; bytes: number }
  | { ok: false; reason: "not-open" | "backpressure" | "invalid" };

export interface DataChannelWrapper {
  readonly label: string;
  /** Snapshot of the underlying channel's `readyState`. */
  readonly state: DataChannelStateValue;
  /** Live byte count waiting to be transmitted. */
  readonly bufferedAmount: number;
  /**
   * Send a text frame. Returns `{ ok: false, reason }` without calling
   * `send` if the channel is not open or the buffered-amount ceiling
   * would be exceeded. Non-string input is rejected as `invalid` — the
   * caller is expected to have run validation already (T068), this is
   * just defense-in-depth at the transport seam.
   */
  send(text: string): ChatSendResult;
  /** Closes the channel; idempotent. */
  close(): void;
}

export interface CreateDataChannelWrapperOptions {
  channel: RTCDataChannel;
  /**
   * Maximum in-flight bytes (`channel.bufferedAmount + next message`)
   * before `send` refuses the frame. Default mirrors Chromium's soft
   * warning threshold (~1 MiB) — far larger than any single chat
   * message, but small enough that a runaway loop can't wedge the
   * browser. Chat frames are tiny, so in practice this is a backstop.
   */
  bufferedAmountCeiling?: number;
  /** Called on every `readyState` transition (including initial). */
  onStateChange?: (state: DataChannelStateValue) => void;
  /**
   * Called on every inbound `message` event. `data` is always the raw
   * payload from the browser event — callers MUST validate before
   * treating it as chat text (see `validateChatMessage` in
   * `state/chat.ts`). Non-string payloads still fire this callback so
   * the caller can log a "rejected non-string frame" event.
   */
  onMessage?: (data: unknown) => void;
  /** Called on transport `error` events (rare; typically fatal). */
  onError?: (event: Event) => void;
}

export const DEFAULT_BUFFERED_AMOUNT_CEILING = 1_048_576; // 1 MiB

/**
 * Maps `RTCDataChannel.readyState` to the contract-level enum.
 * The browser enum lacks "absent"; callers synthesize that value when
 * there is no channel at all (e.g., before `createDataChannel` has run
 * or after a full reset).
 */
export function readyStateToDataChannelState(
  readyState: RTCDataChannelState,
): DataChannelStateValue {
  switch (readyState) {
    case "connecting":
      return "connecting";
    case "open":
      return "open";
    case "closing":
      return "closing";
    case "closed":
      return "closed";
    default: {
      // Defensive — RTCDataChannelState is a closed union in the DOM
      // lib, but browsers have historically added new values. Treat
      // unknowns as `closed` rather than throwing from a callback.
      return "closed";
    }
  }
}

export function wrapDataChannel(
  options: CreateDataChannelWrapperOptions,
): DataChannelWrapper {
  const {
    channel,
    bufferedAmountCeiling = DEFAULT_BUFFERED_AMOUNT_CEILING,
    onStateChange,
    onMessage,
    onError,
  } = options;
  let closed = false;

  const emitState = (): void => {
    onStateChange?.(readyStateToDataChannelState(channel.readyState));
  };

  // Fire initial state synchronously so consumers see the current
  // value without racing the first browser event. Creation of a new
  // channel begins at "connecting" (offerer side) or "open" (answerer
  // side on modern browsers, where the handshake completed before
  // `ondatachannel` fired).
  emitState();

  channel.addEventListener("open", emitState);
  channel.addEventListener("closing", emitState);
  channel.addEventListener("close", emitState);
  if (onError) channel.addEventListener("error", onError);
  if (onMessage) {
    channel.addEventListener("message", (ev: MessageEvent) => {
      onMessage(ev.data);
    });
  }

  return {
    label: channel.label,
    get state(): DataChannelStateValue {
      return readyStateToDataChannelState(channel.readyState);
    },
    get bufferedAmount(): number {
      return channel.bufferedAmount;
    },
    send(text: string): ChatSendResult {
      if (typeof text !== "string") {
        return { ok: false, reason: "invalid" };
      }
      if (channel.readyState !== "open") {
        return { ok: false, reason: "not-open" };
      }
      // UTF-8 byte length approximation. `TextEncoder` would be exact,
      // but chat text is bounded at 500 chars (FR-015a) so the
      // approximation is always well under the ceiling.
      const approxBytes = text.length * 4;
      if (channel.bufferedAmount + approxBytes > bufferedAmountCeiling) {
        return { ok: false, reason: "backpressure" };
      }
      channel.send(text);
      return { ok: true, bytes: text.length };
    },
    close(): void {
      if (closed) return;
      closed = true;
      try {
        channel.close();
      } catch {
        // idempotent
      }
    },
  };
}
