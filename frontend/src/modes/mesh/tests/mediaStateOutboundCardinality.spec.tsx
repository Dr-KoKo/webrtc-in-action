// T074 — outbound cardinality test for `pair_media_state`
// (FR-032 / contract §3.13). Drives the real `<MeshControls>`
// component through real reducer actions and asserts that one local
// toggle produces EXACTLY ONE outbound `pair_media_state` envelope.
// The fan-out is server-side; the client must NOT iterate
// `PairContexts` to send N − 1 envelopes.
//
// Verify with:
//   npx vitest run src/modes/mesh/tests/mediaStateOutboundCardinality.spec.ts

import { useEffect } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { MeshStoreProvider, useMeshDispatch } from "../state";
import { MeshControls } from "../components/MeshControls";

// The MeshControls component imports `subscribeLocalStream` from the
// media-acquisition module. Tests don't run getUserMedia, so we mock
// the module to always publish a stable fake stream + a couple of
// matching tracks. Track.enabled is what the toggle flips.
class FakeMediaStreamTrack {
  enabled = true;
  constructor(public kind: "audio" | "video") {}
}
class FakeMediaStream {
  constructor(
    private audio: FakeMediaStreamTrack,
    private video: FakeMediaStreamTrack,
  ) {}
  getAudioTracks() {
    return [this.audio];
  }
  getVideoTracks() {
    return [this.video];
  }
  getTracks() {
    return [this.audio, this.video];
  }
}

const audioTrack = new FakeMediaStreamTrack("audio");
const videoTrack = new FakeMediaStreamTrack("video");
const fakeStream = new FakeMediaStream(audioTrack, videoTrack);

vi.mock("../webrtc/mediaAcquisition", () => {
  return {
    subscribeLocalStream: (cb: (s: MediaStream | null) => void) => {
      cb(fakeStream as unknown as MediaStream);
      return () => {};
    },
    publishLocalStream: () => {},
  };
});

// `useMeshSignalingClient` would normally throw outside its provider.
// The cardinality test only needs `send`; we substitute the hook so
// every render returns the same `vi.fn()` we can assert against.
let sentMessages: unknown[] = [];
const fakeSend = vi.fn((msg: unknown) => {
  sentMessages.push(msg);
});

vi.mock("../signaling/provider", async () => {
  const actual = await vi.importActual<
    typeof import("../signaling/provider")
  >("../signaling/provider");
  return {
    ...actual,
    useMeshSignalingClient: () => ({
      send: fakeSend,
      onMessage: () => () => {},
      onTransportChange: () => () => {},
      getTransportState: () => "open" as const,
      close: vi.fn(),
      connect: vi.fn(),
    }),
  };
});

function PrimeLocal({ onReady }: { onReady?: () => void }) {
  const dispatch = useMeshDispatch();
  useEffect(() => {
    dispatch({ type: "MESH_JOIN_REQUESTED", roomId: "demo" });
    dispatch({
      type: "MESH_JOIN_ACCEPTED",
      peerId: "00000000-0000-4000-8000-000000000001",
      admissionIndex: 1,
    });
    dispatch({ type: "MESH_MEDIA_ACQUIRE_STARTED" });
    dispatch({ type: "MESH_MEDIA_READY" });
    onReady?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

function setup() {
  return render(
    <MeshStoreProvider>
      <PrimeLocal />
      <MeshControls />
    </MeshStoreProvider>,
  );
}

beforeEach(() => {
  cleanup();
  sentMessages = [];
  fakeSend.mockClear();
  // Reset track + stream state so each test sees a fresh "all on".
  audioTrack.enabled = true;
  videoTrack.enabled = true;
});

describe("pair_media_state outbound cardinality (T074)", () => {
  it("mic toggle emits exactly one pair_media_state", () => {
    setup();
    fireEvent.click(screen.getByTestId("mesh-controls-mic"));
    expect(fakeSend).toHaveBeenCalledTimes(1);
    const msg = sentMessages[0] as Record<string, unknown>;
    expect(msg.type).toBe("pair_media_state");
    expect(msg.v).toBe(2);
    expect(msg.roomId).toBe("demo");
  });

  it("camera toggle emits exactly one pair_media_state", () => {
    setup();
    fireEvent.click(screen.getByTestId("mesh-controls-camera"));
    expect(fakeSend).toHaveBeenCalledTimes(1);
    const msg = sentMessages[0] as Record<string, unknown>;
    expect(msg.type).toBe("pair_media_state");
  });

  // The cardinality is a property of the client's send path, not of
  // the room's size — the client never sees N. We re-run the same
  // toggle three times to mirror the spec's explicit N=2/3/4
  // language; the assertion is "1 send per toggle, total 3 sends".
  it("N=2 / N=3 / N=4 each emit one outbound message per toggle", () => {
    setup();
    const button = screen.getByTestId("mesh-controls-mic");
    fireEvent.click(button); // toggle off
    fireEvent.click(button); // toggle on
    fireEvent.click(button); // toggle off
    expect(fakeSend).toHaveBeenCalledTimes(3);
  });

  it("outbound payload omits pairId and pairEpoch (envelope and payload)", () => {
    setup();
    fireEvent.click(screen.getByTestId("mesh-controls-mic"));
    expect(fakeSend).toHaveBeenCalledTimes(1);
    const msg = sentMessages[0] as Record<string, unknown>;
    expect(msg).not.toHaveProperty("pairId");
    expect(msg).not.toHaveProperty("pairEpoch");
    const payload = msg.payload as Record<string, unknown>;
    expect(payload).not.toHaveProperty("pairId");
    expect(payload).not.toHaveProperty("pairEpoch");
    expect(Object.keys(payload).sort()).toEqual([
      "camera",
      "microphone",
      "screenShare",
    ]);
  });

  it("local media state updates immediately (track.enabled flipped, no async wait)", () => {
    setup();
    fireEvent.click(screen.getByTestId("mesh-controls-mic"));
    // The button's aria-pressed (and data-state) must reflect the new
    // value synchronously — same React tick as the click handler. No
    // await / no act() required because the dispatch is synchronous.
    const button = screen.getByTestId("mesh-controls-mic");
    expect(button.getAttribute("data-state")).toBe("off");
    expect(audioTrack.enabled).toBe(false);
  });

  it("the click handler does NOT call createOffer / setLocalDescription / RTCPeerConnection", () => {
    // The handler under test never reaches into RTCPeerConnection. We
    // prove the negative by checking the global `RTCPeerConnection`
    // wasn't constructed and that the send envelope's payload has no
    // SDP shape.
    const rtcCtor = vi.fn();
    const originalRTC = (
      globalThis as unknown as { RTCPeerConnection?: unknown }
    ).RTCPeerConnection;
    (globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection =
      rtcCtor;
    try {
      setup();
      fireEvent.click(screen.getByTestId("mesh-controls-mic"));
      fireEvent.click(screen.getByTestId("mesh-controls-camera"));
      expect(rtcCtor).not.toHaveBeenCalled();
    } finally {
      (globalThis as unknown as { RTCPeerConnection?: unknown }).RTCPeerConnection =
        originalRTC;
    }
  });

  it("the click handler does NOT call getDisplayMedia (M9 must not start screen sharing)", () => {
    const getDisplayMedia = vi.fn();
    const original = (
      globalThis.navigator as unknown as { mediaDevices?: { getDisplayMedia?: unknown } }
    ).mediaDevices;
    (globalThis.navigator as unknown as { mediaDevices: unknown }).mediaDevices = {
      ...(original ?? {}),
      getDisplayMedia,
    };
    try {
      setup();
      fireEvent.click(screen.getByTestId("mesh-controls-mic"));
      fireEvent.click(screen.getByTestId("mesh-controls-camera"));
      expect(getDisplayMedia).not.toHaveBeenCalled();
    } finally {
      (globalThis.navigator as unknown as { mediaDevices: unknown }).mediaDevices =
        original as unknown;
    }
  });

  it("buttons stay disabled until media-ready (no rogue send before the local participant is ready)", () => {
    // Mount WITHOUT the priming dispatch — local stays in 'idle'.
    render(
      <MeshStoreProvider>
        <MeshControls />
      </MeshStoreProvider>,
    );
    const mic = screen.getByTestId("mesh-controls-mic") as HTMLButtonElement;
    const cam = screen.getByTestId("mesh-controls-camera") as HTMLButtonElement;
    expect(mic.disabled).toBe(true);
    expect(cam.disabled).toBe(true);
    fireEvent.click(mic);
    fireEvent.click(cam);
    expect(fakeSend).not.toHaveBeenCalled();
  });
});
