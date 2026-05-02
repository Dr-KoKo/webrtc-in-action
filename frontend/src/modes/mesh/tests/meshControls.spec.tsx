// M9 / T069 — `<MeshControls>` behavior. Covers:
//   - microphone button flips the local audio track's `enabled` bit
//     (does NOT stop the track, does NOT call replaceTrack).
//   - camera button flips the local video track's `enabled` bit.
//   - toggles do NOT call createOffer / setLocalDescription / open
//     a new RTCPeerConnection / call getDisplayMedia.
//   - buttons stay disabled until local media is acquired AND the
//     local participant FSM is `media-ready`.
//
// Verify:
//   npx vitest run src/modes/mesh/tests/meshControls.spec.tsx

import { useEffect } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { MeshStoreProvider, useMeshDispatch } from "../state";
import { MeshControls } from "../components/MeshControls";

class FakeMediaStreamTrack {
  enabled = true;
  public stopped = false;
  constructor(public kind: "audio" | "video") {}
  stop() {
    this.stopped = true;
  }
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

vi.mock("../webrtc/mediaAcquisition", () => ({
  subscribeLocalStream: (cb: (s: MediaStream | null) => void) => {
    cb(fakeStream as unknown as MediaStream);
    return () => {};
  },
}));

const fakeSend = vi.fn();
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

function PrimeReady() {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

function setupReady() {
  return render(
    <MeshStoreProvider>
      <PrimeReady />
      <MeshControls />
    </MeshStoreProvider>,
  );
}

beforeEach(() => {
  cleanup();
  fakeSend.mockClear();
  audioTrack.enabled = true;
  videoTrack.enabled = true;
  audioTrack.stopped = false;
  videoTrack.stopped = false;
});

describe("<MeshControls> mic toggle", () => {
  it("flips the local audio track's enabled flag", () => {
    setupReady();
    expect(audioTrack.enabled).toBe(true);
    fireEvent.click(screen.getByTestId("mesh-controls-mic"));
    expect(audioTrack.enabled).toBe(false);
    fireEvent.click(screen.getByTestId("mesh-controls-mic"));
    expect(audioTrack.enabled).toBe(true);
  });

  it("does NOT stop the audio track", () => {
    setupReady();
    fireEvent.click(screen.getByTestId("mesh-controls-mic"));
    expect(audioTrack.stopped).toBe(false);
    fireEvent.click(screen.getByTestId("mesh-controls-mic"));
    expect(audioTrack.stopped).toBe(false);
  });
});

describe("<MeshControls> camera toggle", () => {
  it("flips the local video track's enabled flag", () => {
    setupReady();
    expect(videoTrack.enabled).toBe(true);
    fireEvent.click(screen.getByTestId("mesh-controls-camera"));
    expect(videoTrack.enabled).toBe(false);
    fireEvent.click(screen.getByTestId("mesh-controls-camera"));
    expect(videoTrack.enabled).toBe(true);
  });

  it("does NOT stop the video track", () => {
    setupReady();
    fireEvent.click(screen.getByTestId("mesh-controls-camera"));
    expect(videoTrack.stopped).toBe(false);
  });
});

describe("<MeshControls> renegotiation forbidden", () => {
  it("toggles never construct a new RTCPeerConnection", () => {
    const rtcCtor = vi.fn();
    const orig = (
      globalThis as unknown as { RTCPeerConnection?: unknown }
    ).RTCPeerConnection;
    (globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection =
      rtcCtor;
    try {
      setupReady();
      fireEvent.click(screen.getByTestId("mesh-controls-mic"));
      fireEvent.click(screen.getByTestId("mesh-controls-camera"));
      expect(rtcCtor).not.toHaveBeenCalled();
    } finally {
      (globalThis as unknown as { RTCPeerConnection?: unknown }).RTCPeerConnection =
        orig;
    }
  });

  it("toggles never call getDisplayMedia (M10 boundary; M9 is mic+camera only)", () => {
    const getDisplayMedia = vi.fn();
    const orig = (
      globalThis.navigator as unknown as {
        mediaDevices?: { getDisplayMedia?: unknown };
      }
    ).mediaDevices;
    (globalThis.navigator as unknown as { mediaDevices: unknown }).mediaDevices = {
      ...(orig ?? {}),
      getDisplayMedia,
    };
    try {
      setupReady();
      fireEvent.click(screen.getByTestId("mesh-controls-mic"));
      fireEvent.click(screen.getByTestId("mesh-controls-camera"));
      expect(getDisplayMedia).not.toHaveBeenCalled();
    } finally {
      (globalThis.navigator as unknown as { mediaDevices: unknown }).mediaDevices =
        orig as unknown;
    }
  });
});

describe("<MeshControls> button gating", () => {
  it("buttons are disabled until media-ready", () => {
    render(
      <MeshStoreProvider>
        <MeshControls />
      </MeshStoreProvider>,
    );
    expect(
      (screen.getByTestId("mesh-controls-mic") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId("mesh-controls-camera") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("buttons are enabled once media-ready", () => {
    setupReady();
    expect(
      (screen.getByTestId("mesh-controls-mic") as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      (screen.getByTestId("mesh-controls-camera") as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("local indicator surfaces show mic on/off and camera on/off", () => {
    setupReady();
    expect(
      screen.getByTestId("mesh-controls-mic").getAttribute("data-state"),
    ).toBe("on");
    fireEvent.click(screen.getByTestId("mesh-controls-mic"));
    expect(
      screen.getByTestId("mesh-controls-mic").getAttribute("data-state"),
    ).toBe("off");
    expect(
      screen.getByTestId("mesh-controls-camera").getAttribute("data-state"),
    ).toBe("on");
    fireEvent.click(screen.getByTestId("mesh-controls-camera"));
    expect(
      screen.getByTestId("mesh-controls-camera").getAttribute("data-state"),
    ).toBe("off");
  });

  it("screen-share indicator stays inactive in M9 (no getDisplayMedia)", () => {
    setupReady();
    expect(
      screen
        .getByTestId("mesh-controls-screen-share")
        .getAttribute("data-state"),
    ).toBe("inactive");
  });
});
