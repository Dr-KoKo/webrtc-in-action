// Signaling client open-failure tests. Regression coverage for the
// "connect() stays pending forever when the WS fails to open" bug.

import { describe, expect, it, vi } from "vitest";
import { createSignalingClient } from "@/modes/one-to-one/signaling/client";

type Handlers = {
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
};

function makeFakeSocket(): Handlers & {
  readyState: number;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  return {
    readyState: 0,
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send: vi.fn(),
    close: vi.fn(),
  };
}

describe("signaling client", () => {
  it("rejects connect() when the WS fires onerror + onclose before onopen", async () => {
    const fake = makeFakeSocket();
    const client = createSignalingClient(() => fake as never);
    const promise = client.connect("ws://example.test/ws");
    // Simulate browser calling onerror (sets transport=error), then
    // onclose — mirrors the real failed-connect sequence.
    fake.onerror?.({} as Event);
    fake.onclose?.({} as CloseEvent);
    await expect(promise).rejects.toThrowError(/closed before open/);
    expect(client.getTransportState()).toBe("error");
  });

  it("resolves connect() on onopen and stays connected", async () => {
    const fake = makeFakeSocket();
    const client = createSignalingClient(() => fake as never);
    const promise = client.connect("ws://example.test/ws");
    fake.readyState = 1;
    fake.onopen?.({} as Event);
    await expect(promise).resolves.toBeUndefined();
    expect(client.getTransportState()).toBe("connected");
  });

  it("close() is idempotent and moves transport to disconnected", async () => {
    const fake = makeFakeSocket();
    const client = createSignalingClient(() => fake as never);
    const promise = client.connect("ws://example.test/ws");
    fake.readyState = 1;
    fake.onopen?.({} as Event);
    await promise;
    client.close();
    client.close();
    expect(fake.close).toHaveBeenCalledTimes(1);
    expect(client.getTransportState()).toBe("disconnected");
  });
});
