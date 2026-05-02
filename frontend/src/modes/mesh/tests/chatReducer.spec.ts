// T062 — chat reducer (`state/chat.ts`) acceptance tests.
//
// The reducer is pure: callers compute IDs and timestamps. We assert
// the data-model §B.5 invariants:
//   - `MESH_CHAT_LOCAL_APPENDED` appends one message + one fan-out
//     entry; a duplicate dispatch on the SAME messageId is a no-op
//     (FR-052a — local echo MUST appear exactly once).
//   - `MESH_CHAT_INBOUND_APPENDED` appends one message; per-channel
//     order is preserved (FR-055).
//   - Validation events round-trip through `lastValidationError`.

import { describe, expect, it } from "vitest";
import {
  initialMeshChatSlice,
  meshChatReducer,
  validateMeshChatInput,
  MESH_CHAT_MAX_LEN,
  type MeshChatFanOut,
  type MeshChatMessage,
} from "../state/chat";

const SELF = "99999999-9999-4999-8999-999999999999";
const REMOTE = "11111111-1111-4111-8111-111111111111";

function makeMsg(over: Partial<MeshChatMessage>): MeshChatMessage {
  return {
    id: over.id ?? "msg-1",
    authorPeerId: over.authorPeerId ?? SELF,
    text: over.text ?? "hi",
    ...(over.sentAt !== undefined ? { sentAt: over.sentAt } : {}),
    ...(over.receivedAt !== undefined ? { receivedAt: over.receivedAt } : {}),
  };
}

function makeFan(over: Partial<MeshChatFanOut>): MeshChatFanOut {
  return {
    messageId: over.messageId ?? "msg-1",
    attempted: over.attempted ?? 0,
    succeeded: over.succeeded ?? 0,
    skipped: over.skipped ?? [],
  };
}

describe("meshChatReducer", () => {
  it("appends one local-echo message + fan-out per send", () => {
    const after = meshChatReducer(initialMeshChatSlice, {
      type: "MESH_CHAT_LOCAL_APPENDED",
      message: makeMsg({ id: "msg-1", text: "hi", sentAt: 1000 }),
      fanOut: makeFan({ messageId: "msg-1", attempted: 3, succeeded: 3 }),
    });
    expect(after.messages).toHaveLength(1);
    expect(after.messages[0].text).toBe("hi");
    expect(after.fanOutByMessageId["msg-1"].attempted).toBe(3);
    expect(after.fanOutByMessageId["msg-1"].succeeded).toBe(3);
  });

  it("idempotent on duplicate local-append for the same messageId", () => {
    let s = meshChatReducer(initialMeshChatSlice, {
      type: "MESH_CHAT_LOCAL_APPENDED",
      message: makeMsg({ id: "dup", text: "hi" }),
      fanOut: makeFan({ messageId: "dup", attempted: 1, succeeded: 1 }),
    });
    s = meshChatReducer(s, {
      type: "MESH_CHAT_LOCAL_APPENDED",
      message: makeMsg({ id: "dup", text: "hi" }),
      fanOut: makeFan({ messageId: "dup", attempted: 1, succeeded: 1 }),
    });
    expect(s.messages).toHaveLength(1);
  });

  it("appends inbound messages in arrival order without reordering", () => {
    let s = meshChatReducer(initialMeshChatSlice, {
      type: "MESH_CHAT_INBOUND_APPENDED",
      message: makeMsg({
        id: "in-1",
        authorPeerId: REMOTE,
        text: "later-sentAt arriving first",
        sentAt: 2000,
        receivedAt: 5000,
      }),
    });
    s = meshChatReducer(s, {
      type: "MESH_CHAT_INBOUND_APPENDED",
      message: makeMsg({
        id: "in-2",
        authorPeerId: REMOTE,
        text: "earlier-sentAt arriving second",
        sentAt: 1500,
        receivedAt: 5100,
      }),
    });
    // Per-channel arrival order is what we render — we MUST NOT
    // reorder by sender clock (FR-055 / no global ordering).
    expect(s.messages.map((m) => m.id)).toEqual(["in-1", "in-2"]);
  });

  it("clears validation state after successful local append", () => {
    let s = meshChatReducer(initialMeshChatSlice, {
      type: "MESH_CHAT_VALIDATION_FAILED",
      reason: "empty",
      attemptedAt: 1,
      textLength: 0,
    });
    expect(s.lastValidationError?.reason).toBe("empty");
    s = meshChatReducer(s, {
      type: "MESH_CHAT_LOCAL_APPENDED",
      message: makeMsg({ id: "msg-x" }),
      fanOut: makeFan({ messageId: "msg-x" }),
    });
    expect(s.lastValidationError).toBeNull();
  });

  it("MESH_CHAT_VALIDATION_CLEARED resets lastValidationError", () => {
    let s = meshChatReducer(initialMeshChatSlice, {
      type: "MESH_CHAT_VALIDATION_FAILED",
      reason: "too_long",
      attemptedAt: 1,
      textLength: 999,
    });
    s = meshChatReducer(s, { type: "MESH_CHAT_VALIDATION_CLEARED" });
    expect(s.lastValidationError).toBeNull();
  });

  it("MESH_CHAT_RESET clears messages + fan-out", () => {
    let s = meshChatReducer(initialMeshChatSlice, {
      type: "MESH_CHAT_LOCAL_APPENDED",
      message: makeMsg({ id: "x" }),
      fanOut: makeFan({ messageId: "x" }),
    });
    s = meshChatReducer(s, { type: "MESH_CHAT_RESET" });
    expect(s.messages).toEqual([]);
    expect(s.fanOutByMessageId).toEqual({});
  });
});

describe("validateMeshChatInput", () => {
  it("rejects empty input", () => {
    expect(validateMeshChatInput("")).toEqual({ ok: false, reason: "empty", trimmed: "" });
  });
  it("rejects whitespace-only input", () => {
    expect(validateMeshChatInput("   \n\t  ")).toEqual({
      ok: false,
      reason: "empty",
      trimmed: "",
    });
  });
  it("rejects > 500 chars after trim", () => {
    const overlong = "a".repeat(MESH_CHAT_MAX_LEN + 1);
    expect(validateMeshChatInput(overlong).ok).toBe(false);
  });
  it("accepts exactly 500 chars", () => {
    const exact = "a".repeat(MESH_CHAT_MAX_LEN);
    expect(validateMeshChatInput(exact)).toEqual({ ok: true, trimmed: exact });
  });
  it("trims surrounding whitespace before length check", () => {
    const exact = "  " + "a".repeat(MESH_CHAT_MAX_LEN) + "  ";
    expect(validateMeshChatInput(exact).ok).toBe(true);
  });
});
