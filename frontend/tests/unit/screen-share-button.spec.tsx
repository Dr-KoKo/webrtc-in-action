// ScreenShareButton regression guard — Phase 11 review-response.
//
// Pins four button-level invariants that the controller spec
// (`screen-share.spec.ts`) cannot see because they live in the glue
// between `ScreenShareButton`'s hooks and the reducer / signaling
// client:
//
//   1. Enabled-gate revert — stop-after-mute reverts to the live
//      (but `enabled=false`) camera track, not `null`. A regression
//      that re-introduces the `.enabled` gate in `getCameraTrack`
//      would fail this: stop() would call `replaceTrack(null)` and
//      a subsequent unmute would flip a detached track's flag only.
//   2. Unmount cleanup — unmounting the button while screen share is
//      active releases the capture (replaceTrack reverts + screen
//      track's .stop() fires). A regression that drops the unmount
//      effect would fail this.
//   3. Transceiver-keyed sender fallback — when all sender tracks are
//      null (post-stop-with-camera-off), `getVideoSender` must locate
//      the video sender via the transceiver whose
//      `receiver.track.kind === "video"`, not by null-track iteration
//      order. A regression to the old `senders.find(s => s.track ===
//      null)` pattern would match the audio sender first and fail.
//   4. Full-triplet media_state — every start and stop sends a
//      `media_state` envelope whose payload carries all three fields
//      (microphone, camera, screenShare). Contract §3.11 pins this;
//      the controller spec only sees the screenShare half because its
//      `emitMediaState` stub records the single parameter.
//
// The test harness mirrors `tests/unit/media-controls.spec.ts` — fake
// LocalMediaContext, minimal SignalingProvider shim, fake signaling
// client whose `.send` is a spy — and adds a PeerConnectionContext
// provider whose value returns a stub handle with mockable
// `pc.getSenders()` / `pc.getTransceivers()` / `pc.signalingState`.

import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { ScreenShareButton } from "../../src/components/ScreenShareButton";
import {
  StoreProvider,
  initialRootState,
  type RootState,
} from "../../src/state";
import {
  LocalMediaContext,
  type LocalMediaContextValue,
} from "../../src/webrtc/local-media-provider";
import {
  PeerConnectionContext,
  type PeerConnectionContextValue,
} from "../../src/webrtc/peer-connection-provider";
import type { PeerConnectionHandle } from "../../src/webrtc/peer-connection";
import { SignalingProvider } from "../../src/signaling/provider";
import type { SignalingClient } from "../../src/signaling/client";
import { initialInspectorSnapshot } from "../../src/webrtc/learning-inspector";

// ---------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------

interface FakeTrack {
  kind: "audio" | "video";
  enabled: boolean;
  readyState: "live" | "ended";
  stop: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  _listeners: Record<string, Array<(ev?: unknown) => void>>;
  fireEnded(): void;
}

function makeTrack(kind: "audio" | "video", enabled = true): FakeTrack {
  const listeners: Record<string, Array<(ev?: unknown) => void>> = {};
  const t: FakeTrack = {
    kind,
    enabled,
    readyState: "live",
    stop: vi.fn(() => {
      t.readyState = "ended";
    }),
    addEventListener: vi.fn((ev: string, cb: (ev?: unknown) => void) => {
      (listeners[ev] ??= []).push(cb);
    }),
    _listeners: listeners,
    fireEnded: () => {
      for (const cb of listeners["ended"] ?? []) cb();
    },
  };
  return t;
}

function makeStream(tracks: FakeTrack[]): MediaStream {
  return {
    getAudioTracks: () => tracks.filter((t) => t.kind === "audio"),
    getVideoTracks: () => tracks.filter((t) => t.kind === "video"),
    getTracks: () => tracks,
  } as unknown as MediaStream;
}

interface FakeSender {
  track: MediaStreamTrack | null;
  replaceTrack: ReturnType<typeof vi.fn>;
}

function makeSender(initial: FakeTrack | null): FakeSender {
  const s: FakeSender = {
    track: (initial as unknown as MediaStreamTrack | null),
    replaceTrack: vi.fn((next: MediaStreamTrack | null) => {
      s.track = next;
      return Promise.resolve();
    }),
  };
  return s;
}

interface FakeTransceiver {
  sender: FakeSender;
  receiver: { track: FakeTrack | null };
}

interface FakePc {
  signalingState: RTCSignalingState;
  createOffer: ReturnType<typeof vi.fn>;
  setLocalDescription: ReturnType<typeof vi.fn>;
  setRemoteDescription: ReturnType<typeof vi.fn>;
  getSenders: () => FakeSender[];
  getTransceivers: () => FakeTransceiver[];
}

function makePc(senders: FakeSender[], transceivers: FakeTransceiver[]): FakePc {
  return {
    signalingState: "stable",
    createOffer: vi.fn(),
    setLocalDescription: vi.fn(),
    setRemoteDescription: vi.fn(),
    getSenders: () => senders,
    getTransceivers: () => transceivers,
  };
}

interface FakeSignalingClient {
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  onMessage: () => () => void;
  onTransportChange: () => () => void;
  getTransportState: () => "connected";
  connect: () => Promise<void>;
}

function makeFakeSignalingClient(): FakeSignalingClient {
  return {
    send: vi.fn(),
    close: vi.fn(),
    onMessage: () => () => {},
    onTransportChange: () => () => {},
    getTransportState: () => "connected" as const,
    connect: () => Promise.resolve(),
  };
}

function connectedRootState(): RootState {
  return {
    ...initialRootState,
    session: {
      ...initialRootState.session,
      session: "connected",
      transport: "connected",
      roomId: "demo",
      selfPeerId: "11111111-2222-3333-4444-555555555555",
      admissionOrder: 1,
      remoteParticipant: null,
      joinError: null,
    },
  };
}

interface RenderArgs {
  stream: MediaStream | null;
  pc: FakePc;
  client: FakeSignalingClient;
  initialState?: RootState;
}

function renderButton(args: RenderArgs) {
  const localMediaValue: LocalMediaContextValue = {
    getStream: () => args.stream,
    streamVersion: args.stream ? 1 : 0,
    hasStream: args.stream !== null,
    release: () => {},
  };
  const pcValue: PeerConnectionContextValue = {
    getHandle: () =>
      ({
        pc: args.pc as unknown as RTCPeerConnection,
      } as unknown as PeerConnectionHandle),
    getRemoteStream: () => null,
    remoteStreamVersion: 0,
    hasRemoteStream: false,
    inspector: initialInspectorSnapshot,
    sendChatMessage: () => ({ ok: false, reason: "not-open" }),
  };
  const Wrapper = ({ children }: { children: ReactNode }) =>
    createElement(StoreProvider, {
      initialState: args.initialState ?? connectedRootState(),
      children: createElement(SignalingProvider, {
        client: args.client as unknown as SignalingClient,
        children: createElement(LocalMediaContext.Provider, {
          value: localMediaValue,
          children: createElement(PeerConnectionContext.Provider, {
            value: pcValue,
            children,
          }),
        }),
      }),
    });
  return render(createElement(ScreenShareButton), { wrapper: Wrapper });
}

// Vitest's `vi.fn(async () => ...)` isn't needed here — getDisplayMedia
// is plucked from `navigator.mediaDevices` in production. The controller
// inside the button reaches for `navigator.mediaDevices.getDisplayMedia`
// directly, so we stub that global for these tests.
function stubGetDisplayMedia(stream: MediaStream): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => stream);
  const nav = navigator as unknown as {
    mediaDevices: { getDisplayMedia: typeof fn };
  };
  if (!nav.mediaDevices) {
    (nav as unknown as { mediaDevices: { getDisplayMedia: typeof fn } }).mediaDevices = {
      getDisplayMedia: fn,
    };
  } else {
    nav.mediaDevices.getDisplayMedia = fn;
  }
  return fn;
}

// Drain the async chain `click → start() → getDisplayMedia →
// replaceTrack → emitMediaState → dispatch`. `vi.waitFor` retries the
// assertion until the replaceTrack spy has fired — runtime-agnostic.
// Wrapped in `act` so the subsequent reducer dispatches (from
// emitMediaState + event-log appends) flush inside an act() scope
// and React doesn't warn.
async function waitForReplaceTrack(
  sender: FakeSender,
  calls: number,
): Promise<void> {
  await act(async () => {
    await vi.waitFor(() => {
      expect(sender.replaceTrack).toHaveBeenCalledTimes(calls);
    });
  });
}

// ---------------------------------------------------------------------
// (1) enabled-gate revert — muted camera must still be returned
// ---------------------------------------------------------------------

describe("ScreenShareButton — enabled-gate revert (claim 1)", () => {
  it("stop after mute reverts to the live-but-disabled camera track, not null", async () => {
    const audio = makeTrack("audio", true);
    const camera = makeTrack("video", false); // muted via MediaControls
    const stream = makeStream([audio, camera]);

    const audioSender = makeSender(audio);
    const videoSender = makeSender(camera);
    const pc = makePc(
      [audioSender, videoSender],
      [
        { sender: audioSender, receiver: { track: makeTrack("audio") } },
        { sender: videoSender, receiver: { track: makeTrack("video") } },
      ],
    );
    const screen = makeTrack("video");
    stubGetDisplayMedia(makeStream([screen]));
    const client = makeFakeSignalingClient();

    const { getByTestId, unmount } = renderButton({ stream, pc, client });
    const button = getByTestId("screen-share-toggle");

    // Start screen share.
    act(() => {
      fireEvent.click(button);
    });
    await waitForReplaceTrack(videoSender, 1);
    expect(videoSender.replaceTrack.mock.calls[0][0]).toBe(screen);

    // Stop via the in-app button.
    act(() => {
      fireEvent.click(button);
    });
    await waitForReplaceTrack(videoSender, 2);
    // Critical: the second replaceTrack must carry the muted camera
    // track, not `null`. A regression that re-introduces the
    // `.enabled` gate in getCameraTrack would pass `null` here and
    // leave the sender permanently track-less.
    expect(videoSender.replaceTrack.mock.calls[1][0]).toBe(camera);
    unmount();
  });
});

// ---------------------------------------------------------------------
// (2) unmount cleanup — live capture released on component unmount
// ---------------------------------------------------------------------

describe("ScreenShareButton — unmount cleanup (claim 2)", () => {
  it("unmounting while screen share is active releases the capture", async () => {
    const audio = makeTrack("audio");
    const camera = makeTrack("video");
    const stream = makeStream([audio, camera]);

    const audioSender = makeSender(audio);
    const videoSender = makeSender(camera);
    const pc = makePc(
      [audioSender, videoSender],
      [
        { sender: audioSender, receiver: { track: makeTrack("audio") } },
        { sender: videoSender, receiver: { track: makeTrack("video") } },
      ],
    );
    const screen = makeTrack("video");
    stubGetDisplayMedia(makeStream([screen]));
    const client = makeFakeSignalingClient();

    const { getByTestId, unmount } = renderButton({ stream, pc, client });
    act(() => {
      fireEvent.click(getByTestId("screen-share-toggle"));
    });
    await waitForReplaceTrack(videoSender, 1);
    expect(videoSender.replaceTrack.mock.calls[0][0]).toBe(screen);

    // Unmount while screen share is live. The cleanup effect must
    // fire a second replaceTrack (reverting to camera) and stop the
    // screen track. Without the effect, neither happens.
    unmount();
    await act(async () => {
      await vi.waitFor(() => {
        expect(videoSender.replaceTrack).toHaveBeenCalledTimes(2);
      });
    });
    expect(videoSender.replaceTrack.mock.calls[1][0]).toBe(camera);
    expect(screen.stop).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------
// (3) transceiver fallback — all sender tracks null, find via kind
// ---------------------------------------------------------------------

describe("ScreenShareButton — transceiver-keyed sender fallback (claim 4)", () => {
  it("picks the video transceiver's sender even when all sender tracks are null", async () => {
    const camera = makeTrack("video");
    const stream = makeStream([makeTrack("audio"), camera]);

    // Both senders have null tracks — simulates the post-stop-with-
    // camera-off state. The old null-track iteration fallback would
    // pick the first (audio) sender by order; the new transceiver
    // fallback must key on receiver.track.kind and pick the video
    // sender regardless of position.
    const audioSender = makeSender(null);
    const videoSender = makeSender(null);
    const pc = makePc(
      [audioSender, videoSender],
      [
        { sender: audioSender, receiver: { track: makeTrack("audio") } },
        { sender: videoSender, receiver: { track: makeTrack("video") } },
      ],
    );
    const screen = makeTrack("video");
    stubGetDisplayMedia(makeStream([screen]));
    const client = makeFakeSignalingClient();

    const { getByTestId, unmount } = renderButton({ stream, pc, client });
    act(() => {
      fireEvent.click(getByTestId("screen-share-toggle"));
    });
    await waitForReplaceTrack(videoSender, 1);
    // Video sender received the screen track; audio sender untouched.
    expect(videoSender.replaceTrack.mock.calls[0][0]).toBe(screen);
    expect(audioSender.replaceTrack).not.toHaveBeenCalled();
    unmount();
  });
});

// ---------------------------------------------------------------------
// (4) full-triplet send — contract §3.11
// ---------------------------------------------------------------------

describe("ScreenShareButton — full-triplet media_state send (claim 6 / §3.11)", () => {
  it("every start and stop sends media_state with all three payload fields", async () => {
    const audio = makeTrack("audio");
    const camera = makeTrack("video");
    const stream = makeStream([audio, camera]);

    const audioSender = makeSender(audio);
    const videoSender = makeSender(camera);
    const pc = makePc(
      [audioSender, videoSender],
      [
        { sender: audioSender, receiver: { track: makeTrack("audio") } },
        { sender: videoSender, receiver: { track: makeTrack("video") } },
      ],
    );
    const screen = makeTrack("video");
    stubGetDisplayMedia(makeStream([screen]));
    const client = makeFakeSignalingClient();

    const { getByTestId, unmount } = renderButton({ stream, pc, client });
    const button = getByTestId("screen-share-toggle");

    act(() => {
      fireEvent.click(button);
    });
    await waitForReplaceTrack(videoSender, 1);
    act(() => {
      fireEvent.click(button);
    });
    await waitForReplaceTrack(videoSender, 2);

    // Two media_state envelopes expected — one start (active), one
    // stop (inactive). Each must carry all three fields per §3.11;
    // the server rejects partial payloads with `malformed`.
    const mediaStateCalls = client.send.mock.calls
      .map((c) => c[0] as { type: string; payload: unknown })
      .filter((msg) => msg.type === "media_state");
    expect(mediaStateCalls.length).toBeGreaterThanOrEqual(2);
    for (const msg of mediaStateCalls) {
      const payload = msg.payload as {
        microphone?: string;
        camera?: string;
        screenShare?: string;
      };
      expect(payload.microphone === "on" || payload.microphone === "off").toBe(
        true,
      );
      expect(payload.camera === "on" || payload.camera === "off").toBe(true);
      expect(
        payload.screenShare === "active" || payload.screenShare === "inactive",
      ).toBe(true);
    }
    // First call is active (start), last is inactive (stop).
    const first = mediaStateCalls[0].payload as { screenShare: string };
    const last = mediaStateCalls[mediaStateCalls.length - 1].payload as {
      screenShare: string;
    };
    expect(first.screenShare).toBe("active");
    expect(last.screenShare).toBe("inactive");
    unmount();
  });
});
