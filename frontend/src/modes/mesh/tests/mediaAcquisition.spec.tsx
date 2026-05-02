// F-2 invariant: the FSM transition (`MESH_MEDIA_READY`) is gated on
// `client.send` succeeding. If the WS dies between getUserMedia
// returning and the wire send, the local FSM must NOT advance to
// `media-ready` (server still sees `joined`); instead the freshly
// acquired tracks are stopped, the published stream is cleared, and
// the FSM walks `acquiring-media → media-error` so the user sees
// the banner and can Retry.
//
// Stream publication (`publishLocalStream`) happens BEFORE the send
// so `LocalPreview` renders the live tile snappy — that's local-only
// and doesn't depend on server confirmation.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";
import { act, render } from "@testing-library/react";
import * as sharedMedia from "@/shared/webrtc/media-acquisition";
import { MeshStoreProvider, useMeshDispatch } from "../state";
import { MeshSignalingProvider } from "../signaling/provider";
import { MeshMediaController } from "../webrtc/mediaAcquisition";
import type { MeshSignalingClient } from "../signaling/client";

const SELF = "99999999-9999-4999-8999-999999999999";

function makeMockClient(opts: {
  sendImpl?: (msg: unknown) => void;
}): MeshSignalingClient {
  const sendImpl =
    opts.sendImpl ??
    (() => {
      /* default: succeeds, no-op */
    });
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(sendImpl),
    close: vi.fn(),
    onMessage: vi.fn().mockReturnValue(() => undefined),
    onTransportChange: vi.fn().mockReturnValue(() => undefined),
    getTransportState: vi.fn().mockReturnValue("open" as const),
  } as unknown as MeshSignalingClient;
}

function makeFakeStream(): {
  stream: MediaStream;
  trackStops: ReturnType<typeof vi.fn>[];
} {
  const trackStops = [vi.fn(), vi.fn()];
  const stream = {
    getTracks: () => [
      { stop: trackStops[0] } as unknown as MediaStreamTrack,
      { stop: trackStops[1] } as unknown as MediaStreamTrack,
    ],
  } as unknown as MediaStream;
  return { stream, trackStops };
}

// Pre-flight: drive the store to `joined` with a non-empty roomId
// before the controller's `joined`-keyed effect runs. Use useEffect
// so the dispatches happen after this component commits, not during
// render (React forbids cross-component setState during render).
function PrimeJoined({ roomId, peerId }: { roomId: string; peerId: string }) {
  const dispatch = useMeshDispatch();
  useEffect(() => {
    dispatch({ type: "MESH_JOIN_REQUESTED", roomId });
    dispatch({ type: "MESH_JOIN_ACCEPTED", peerId, admissionIndex: 1 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

beforeEach(() => {
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

describe("MeshMediaController — F-2 send-then-FSM ordering", () => {
  it("does NOT advance to media-ready when client.send throws", async () => {
    const { stream, trackStops } = makeFakeStream();
    vi.spyOn(sharedMedia, "acquireLocalMedia").mockResolvedValue({
      ok: true,
      stream,
    });
    const client = makeMockClient({
      sendImpl: () => {
        throw new Error("ws not open");
      },
    });

    let renderResult: ReturnType<typeof render> | undefined;
    await act(async () => {
      renderResult = render(
        <MeshStoreProvider>
          <MeshSignalingProvider client={client}>
            <PrimeJoined roomId="demo" peerId={SELF} />
            <MeshMediaController />
          </MeshSignalingProvider>
        </MeshStoreProvider>,
      );
      // Let the controller's async getUserMedia + send + dispatch run.
      await Promise.resolve();
      await Promise.resolve();
    });

    // FSM must NOT be media-ready. We can't read state from inside
    // the test directly without a selector ref — instead assert via
    // the visible side effects of the failure path:
    //
    //   1. Tracks were stopped (cleanup ran).
    //   2. client.send was called exactly once (we tried to send).
    //   3. No second send for media_ready ever fired (would imply
    //      retry; not possible without state change).
    expect(client.send).toHaveBeenCalledTimes(1);
    expect((client.send as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      type: "media_ready",
    });
    for (const stop of trackStops) {
      expect(stop).toHaveBeenCalledTimes(1);
    }

    renderResult?.unmount();
  });

  it("advances to media-ready when client.send succeeds", async () => {
    const { stream, trackStops } = makeFakeStream();
    vi.spyOn(sharedMedia, "acquireLocalMedia").mockResolvedValue({
      ok: true,
      stream,
    });
    const client = makeMockClient({
      sendImpl: () => {
        /* succeeds */
      },
    });

    let renderResult: ReturnType<typeof render> | undefined;
    await act(async () => {
      renderResult = render(
        <MeshStoreProvider>
          <MeshSignalingProvider client={client}>
            <PrimeJoined roomId="demo" peerId={SELF} />
            <MeshMediaController />
          </MeshSignalingProvider>
        </MeshStoreProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(client.send).toHaveBeenCalledTimes(1);
    // Tracks must NOT be stopped on the success path — they're owned
    // by streamRef and reused for M6+ pair attachment.
    for (const stop of trackStops) {
      expect(stop).not.toHaveBeenCalled();
    }

    renderResult?.unmount();
  });
});
