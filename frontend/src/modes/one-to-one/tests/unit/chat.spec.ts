// Chat validation + reducer unit tests (T068, Phase 9).
//
// Locks the pure rules from data-model §B.8 + spec FR-015a:
//   - non-string input rejected (`not-string`)
//   - whitespace-only input rejected after trim (`empty`)
//   - trimmed length > 500 rejected (`too-long`)
//   - trimmed length == 500 accepted
//   - emoji (multi-code-unit) accepted as plain text
//   - HTML-like strings pass validation verbatim — the render layer
//     (Chat.tsx) is responsible for rendering them as text, never HTML.
//
// Reducer coverage: append keeps insertion order and returns a fresh
// array (immutability); clear returns the initial slice.

import { describe, expect, it, beforeEach } from "vitest";
import {
  CHAT_MAX_LENGTH,
  __resetChatSequence,
  chatReducer,
  initialChatSlice,
  makeChatMessage,
  validateChatMessage,
} from "@/modes/one-to-one/state/chat";

describe("validateChatMessage", () => {
  it("rejects non-string input", () => {
    expect(validateChatMessage(undefined)).toEqual({
      ok: false,
      reason: "not-string",
    });
    expect(validateChatMessage(null)).toEqual({
      ok: false,
      reason: "not-string",
    });
    expect(validateChatMessage(42)).toEqual({
      ok: false,
      reason: "not-string",
    });
    expect(validateChatMessage({ text: "hi" })).toEqual({
      ok: false,
      reason: "not-string",
    });
  });

  it("rejects empty string", () => {
    expect(validateChatMessage("")).toEqual({ ok: false, reason: "empty" });
  });

  it("rejects whitespace-only string after trim", () => {
    expect(validateChatMessage("   ")).toEqual({ ok: false, reason: "empty" });
    expect(validateChatMessage("\t\n  ")).toEqual({
      ok: false,
      reason: "empty",
    });
  });

  it("accepts exactly 500 trimmed characters", () => {
    const text = "a".repeat(CHAT_MAX_LENGTH);
    expect(validateChatMessage(text)).toEqual({ ok: true, text });
  });

  it("rejects 501 trimmed characters", () => {
    const text = "a".repeat(CHAT_MAX_LENGTH + 1);
    expect(validateChatMessage(text)).toEqual({
      ok: false,
      reason: "too-long",
    });
  });

  it("trims surrounding whitespace before length check", () => {
    // 500 `a`s wrapped in whitespace — trimmed length is still 500.
    const inner = "a".repeat(CHAT_MAX_LENGTH);
    expect(validateChatMessage(`  ${inner}  `)).toEqual({
      ok: true,
      text: inner,
    });
  });

  it("accepts emoji and multi-byte text", () => {
    const text = "hello 🎉 mundo 🌍";
    expect(validateChatMessage(text)).toEqual({ ok: true, text });
  });

  it("accepts HTML-like strings verbatim (rendering layer handles escape)", () => {
    const text = "<script>alert(1)</script>";
    const result = validateChatMessage(text);
    expect(result).toEqual({ ok: true, text });
    // Key invariant: the string is not mutated / stripped by
    // validation. The Chat component must render it as text.
    if (result.ok) {
      expect(result.text).toBe("<script>alert(1)</script>");
    }
  });

  it("accepts a single-character message", () => {
    expect(validateChatMessage("x")).toEqual({ ok: true, text: "x" });
  });
});

describe("chatReducer", () => {
  beforeEach(() => {
    __resetChatSequence();
  });

  it("appends messages in order", () => {
    const m1 = makeChatMessage({ from: "self", text: "hello", ts: 1 });
    const m2 = makeChatMessage({ from: "peer", text: "hi", ts: 2 });
    let state = initialChatSlice;
    state = chatReducer(state, { type: "CHAT_MESSAGE_APPENDED", message: m1 });
    state = chatReducer(state, { type: "CHAT_MESSAGE_APPENDED", message: m2 });
    expect(state.messages).toHaveLength(2);
    expect(state.messages[0]).toBe(m1);
    expect(state.messages[1]).toBe(m2);
  });

  it("returns a fresh array on append (immutability)", () => {
    const m1 = makeChatMessage({ from: "self", text: "hello", ts: 1 });
    const next = chatReducer(initialChatSlice, {
      type: "CHAT_MESSAGE_APPENDED",
      message: m1,
    });
    expect(next.messages).not.toBe(initialChatSlice.messages);
  });

  it("clears transcript on CHAT_CLEARED", () => {
    const m1 = makeChatMessage({ from: "self", text: "hello", ts: 1 });
    const populated = chatReducer(initialChatSlice, {
      type: "CHAT_MESSAGE_APPENDED",
      message: m1,
    });
    const cleared = chatReducer(populated, { type: "CHAT_CLEARED" });
    expect(cleared.messages).toEqual([]);
  });

  it("stamps transport: 'datachannel' on every message", () => {
    const m = makeChatMessage({ from: "self", text: "hello" });
    expect(m.transport).toBe("datachannel");
  });
});
