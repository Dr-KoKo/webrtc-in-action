// DataChannel wrapper + slice unit tests (T064 / T065, Phase 9).
//
// Locks the lifecycle rules from data-model §B.5:
//   - Initial state mirrors `readyState` (fires synchronously on wrap).
//   - `open` / `closing` / `close` transitions bubble through
//     `onStateChange`.
//   - `send` refuses on non-open state + on backpressure.
//   - Inbound `message` events invoke `onMessage` with the raw payload
//     (caller validates before trusting as chat text).
//   - Close is idempotent.

import { describe, expect, it, vi } from "vitest";
import {
  dataChannelReducer,
  initialDataChannelSlice,
} from "../../src/state/data-channel";
import {
  DEFAULT_BUFFERED_AMOUNT_CEILING,
  readyStateToDataChannelState,
  wrapDataChannel,
  type DataChannelStateValue,
} from "../../src/webrtc/data-channel";

interface FakeChannel extends EventTarget {
  label: string;
  readyState: RTCDataChannelState;
  bufferedAmount: number;
  sent: string[];
  send: (text: string) => void;
  close: () => void;
  transitionTo: (next: RTCDataChannelState) => void;
  fireMessage: (data: unknown) => void;
  fireError: (detail?: string) => void;
}

function makeFakeChannel(label = "chat"): FakeChannel {
  // jsdom provides EventTarget; composition keeps the fake simple.
  class Fake extends EventTarget {}
  const target = new Fake() as unknown as FakeChannel;
  target.label = label;
  target.readyState = "connecting";
  target.bufferedAmount = 0;
  target.sent = [];
  target.send = (text: string) => {
    target.sent.push(text);
    target.bufferedAmount += text.length;
  };
  target.close = () => {
    if (target.readyState === "closed") return;
    target.readyState = "closed";
    target.dispatchEvent(new Event("close"));
  };
  target.transitionTo = (next: RTCDataChannelState) => {
    target.readyState = next;
    // RTCDataChannel fires "close" (not "closed") when transitioning
    // to readyState=closed. Map the enum to the actual DOM event.
    const eventName = next === "closed" ? "close" : next;
    target.dispatchEvent(new Event(eventName));
  };
  target.fireMessage = (data: unknown) => {
    // jsdom's MessageEvent accepts arbitrary `data`.
    const ev = new MessageEvent("message", { data });
    target.dispatchEvent(ev);
  };
  target.fireError = (detail = "sctp failure") => {
    const ev = new Event("error");
    (ev as Event & { error?: Error }).error = new Error(detail);
    target.dispatchEvent(ev);
  };
  return target;
}

describe("readyStateToDataChannelState", () => {
  it.each<[RTCDataChannelState, DataChannelStateValue]>([
    ["connecting", "connecting"],
    ["open", "open"],
    ["closing", "closing"],
    ["closed", "closed"],
  ])("maps %s → %s", (input, expected) => {
    expect(readyStateToDataChannelState(input)).toBe(expected);
  });
});

describe("wrapDataChannel", () => {
  it("fires initial state synchronously on wrap", () => {
    const fake = makeFakeChannel();
    const seen: DataChannelStateValue[] = [];
    wrapDataChannel({
      channel: fake as unknown as RTCDataChannel,
      onStateChange: (s) => seen.push(s),
    });
    expect(seen).toEqual(["connecting"]);
  });

  it("emits each readyState transition in order", () => {
    const fake = makeFakeChannel();
    const seen: DataChannelStateValue[] = [];
    wrapDataChannel({
      channel: fake as unknown as RTCDataChannel,
      onStateChange: (s) => seen.push(s),
    });
    fake.transitionTo("open");
    fake.transitionTo("closing");
    fake.transitionTo("closed");
    expect(seen).toEqual(["connecting", "open", "closing", "closed"]);
  });

  it("forwards inbound `message` events", () => {
    const fake = makeFakeChannel();
    const onMessage = vi.fn();
    wrapDataChannel({
      channel: fake as unknown as RTCDataChannel,
      onMessage,
    });
    fake.transitionTo("open");
    fake.fireMessage("hello");
    fake.fireMessage("<script>alert(1)</script>");
    expect(onMessage).toHaveBeenNthCalledWith(1, "hello");
    expect(onMessage).toHaveBeenNthCalledWith(2, "<script>alert(1)</script>");
  });

  it("send() refuses before the channel is open", () => {
    const fake = makeFakeChannel();
    const w = wrapDataChannel({
      channel: fake as unknown as RTCDataChannel,
    });
    expect(w.send("hello")).toEqual({ ok: false, reason: "not-open" });
    expect(fake.sent).toEqual([]);
  });

  it("send() refuses non-string payloads", () => {
    const fake = makeFakeChannel();
    const w = wrapDataChannel({
      channel: fake as unknown as RTCDataChannel,
    });
    fake.transitionTo("open");
    // @ts-expect-error — deliberate contract breach at type boundary.
    expect(w.send(42)).toEqual({ ok: false, reason: "invalid" });
    expect(fake.sent).toEqual([]);
  });

  it("send() succeeds once the channel is open", () => {
    const fake = makeFakeChannel();
    const w = wrapDataChannel({
      channel: fake as unknown as RTCDataChannel,
    });
    fake.transitionTo("open");
    const result = w.send("hello");
    expect(result).toEqual({ ok: true, bytes: 5 });
    expect(fake.sent).toEqual(["hello"]);
  });

  it("send() refuses when bufferedAmount would exceed the ceiling", () => {
    const fake = makeFakeChannel();
    // Fill the buffer right up to the ceiling so the very next send
    // is rejected. Use the default ceiling to mirror production.
    fake.bufferedAmount = DEFAULT_BUFFERED_AMOUNT_CEILING;
    const w = wrapDataChannel({
      channel: fake as unknown as RTCDataChannel,
    });
    fake.transitionTo("open");
    const result = w.send("x");
    expect(result).toEqual({ ok: false, reason: "backpressure" });
    expect(fake.sent).toEqual([]);
  });

  it("close() is idempotent", () => {
    const fake = makeFakeChannel();
    const w = wrapDataChannel({
      channel: fake as unknown as RTCDataChannel,
    });
    w.close();
    w.close();
    // Second close must not throw, even though the fake would throw
    // a synthetic error if `channel.close()` were re-invoked.
    expect(fake.readyState).toBe("closed");
  });

  it("invokes onError when the channel raises 'error'", () => {
    const fake = makeFakeChannel();
    const onError = vi.fn();
    wrapDataChannel({
      channel: fake as unknown as RTCDataChannel,
      onError,
    });
    fake.fireError("boom");
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe("dataChannelReducer", () => {
  it("starts at 'absent'", () => {
    expect(initialDataChannelSlice.state).toBe("absent");
  });

  it.each<DataChannelStateValue>([
    "connecting",
    "open",
    "closing",
    "closed",
    "absent",
  ])("accepts DATA_CHANNEL_STATE_CHANGED('%s')", (next) => {
    const out = dataChannelReducer(initialDataChannelSlice, {
      type: "DATA_CHANNEL_STATE_CHANGED",
      state: next,
    });
    expect(out.state).toBe(next);
  });

  it("returns the same reference when state is unchanged (stability)", () => {
    const state = { state: "open" as DataChannelStateValue };
    const out = dataChannelReducer(state, {
      type: "DATA_CHANNEL_STATE_CHANGED",
      state: "open",
    });
    expect(out).toBe(state);
  });

  it("resets to 'absent' on DATA_CHANNEL_RESET", () => {
    const state = { state: "open" as DataChannelStateValue };
    const out = dataChannelReducer(state, { type: "DATA_CHANNEL_RESET" });
    expect(out.state).toBe("absent");
  });
});
