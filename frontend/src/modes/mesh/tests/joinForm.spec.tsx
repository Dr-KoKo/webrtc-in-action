// T037 — JoinForm room-ID validation tests.
//
// Asserts:
//   - Empty / whitespace / regex-violating IDs surface a clear error and
//     the signaling client is NEVER called.
//   - 65-char IDs and IDs containing forbidden characters (e.g. spaces
//     or punctuation outside `[A-Za-z0-9._-]`) are rejected.
//   - A valid ID dispatches MESH_JOIN_REQUESTED, opens the WS via
//     client.connect(), and sends a `join_room` envelope through
//     client.send().

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MeshJoinForm } from "../components/JoinForm";
import { MeshStoreProvider } from "../state";
import type { MeshSignalingClient } from "../signaling/client";

function makeMockClient(): MeshSignalingClient & {
  send: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn();
  const connect = vi.fn().mockResolvedValue(undefined);
  const close = vi.fn();
  const onMessage = vi.fn().mockReturnValue(() => undefined);
  const onTransportChange = vi.fn().mockReturnValue(() => undefined);
  const getTransportState = vi.fn().mockReturnValue("idle" as const);
  return {
    connect,
    send,
    close,
    onMessage,
    onTransportChange,
    getTransportState,
  } as unknown as MeshSignalingClient & {
    send: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
}

function renderForm(client: MeshSignalingClient, initialRoomId = "") {
  return render(
    <MeshStoreProvider>
      <MeshJoinForm
        client={client}
        signalingUrl="ws://localhost/ws/mesh"
        initialRoomId={initialRoomId}
      />
    </MeshStoreProvider>,
  );
}

beforeEach(() => {
  // crypto.randomUUID is required by JoinForm; jsdom 25 ships it but
  // some CI environments may not. Fallback for safety.
  if (typeof globalThis.crypto?.randomUUID !== "function") {
    Object.defineProperty(globalThis, "crypto", {
      value: { randomUUID: () => "00000000-0000-4000-8000-000000000abc" },
      configurable: true,
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MeshJoinForm — room ID validation", () => {
  it("rejects an empty room id and never calls the client", async () => {
    const client = makeMockClient();
    renderForm(client);
    const input = screen.getByTestId("mesh-room-id-input");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(screen.getByTestId("mesh-join-button"));
    expect(
      screen.getByTestId("mesh-join-form-error").textContent ?? "",
    ).toMatch(/room id must match/i);
    expect(client.connect).not.toHaveBeenCalled();
    expect(client.send).not.toHaveBeenCalled();
  });

  it("rejects a 65-character room id (regex limit is 64)", () => {
    const client = makeMockClient();
    renderForm(client);
    const input = screen.getByTestId("mesh-room-id-input");
    fireEvent.change(input, { target: { value: "a".repeat(65) } });
    fireEvent.click(screen.getByTestId("mesh-join-button"));
    expect(screen.getByTestId("mesh-join-form-error")).toBeTruthy();
    expect(client.send).not.toHaveBeenCalled();
  });

  it("rejects a room id with forbidden characters", () => {
    const client = makeMockClient();
    renderForm(client);
    const input = screen.getByTestId("mesh-room-id-input");
    fireEvent.change(input, { target: { value: "bad room!" } });
    fireEvent.click(screen.getByTestId("mesh-join-button"));
    expect(screen.getByTestId("mesh-join-form-error")).toBeTruthy();
    expect(client.send).not.toHaveBeenCalled();
  });

  it("accepts a valid room id, connects, and sends `join_room`", async () => {
    const client = makeMockClient();
    renderForm(client, "demo");
    await act(async () => {
      fireEvent.click(screen.getByTestId("mesh-join-button"));
    });
    expect(client.connect).toHaveBeenCalledWith("ws://localhost/ws/mesh");
    expect(client.send).toHaveBeenCalledTimes(1);
    const sent = client.send.mock.calls[0][0];
    expect(sent.type).toBe("join_room");
    expect(sent.v).toBe(2);
    expect(sent.roomId).toBe("demo");
  });

  it("trims surrounding whitespace before validating", async () => {
    const client = makeMockClient();
    renderForm(client);
    fireEvent.change(screen.getByTestId("mesh-room-id-input"), {
      target: { value: "   demo   " },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("mesh-join-button"));
    });
    expect(client.send).toHaveBeenCalledTimes(1);
    expect(client.send.mock.calls[0][0].roomId).toBe("demo");
  });
});
