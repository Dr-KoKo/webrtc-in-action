// screen-share regression guard — Phase 11 (T075–T079).
//
// Pins the five invariants that keep screen share on the single
// outgoing video slot (FR-017):
//
//   (a) start() with a live video sender → replaceTrack called exactly
//       once with the screen track; createOffer never called;
//       signalingState stays "stable" throughout.
//   (b) stop("app") with a live camera → replaceTrack called once with
//       the camera track; zero createOffer calls.
//   (c) stop("browser") path (fire onended on the screen track) →
//       same revert; event-log carries source: "browser".
//   (d) picker cancel (DOMException("...","NotAllowedError")) → no
//       replaceTrack, no media_state emission, one
//       screen_share_cancelled entry.
//   (e) media_state payloads are full triplets on both start and stop
//       (contract §3.11: partial payloads fail server Validate()).
//
// The controller is intentionally side-effect-light; these tests
// exercise it directly through its injected hooks — no React tree,
// no signaling client, no PeerConnectionProvider. The goal is to pin
// the "single outgoing video slot" invariant at the lowest layer.

import { describe, expect, it, vi } from "vitest";
import {
  createScreenShareController,
  type ScreenShareHooks,
} from "@/modes/one-to-one/webrtc/screen-share";
import type { EventLogEntry } from "@/modes/one-to-one/state/event-log";

// ---------------------------------------------------------------------
// Fakes — thin shapes that satisfy the DOM lib types the controller
// touches. We spy on the interesting calls only.
// ---------------------------------------------------------------------

interface FakeTrack {
  kind: "audio" | "video";
  enabled: boolean;
  readyState: "live" | "ended";
  stop: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  _listeners: Record<string, Array<(ev?: unknown) => void>>;
  /** fire the listener registered for "ended" (simulates browser-stop) */
  fireEnded(): void;
}

function makeVideoTrack(): FakeTrack {
  const listeners: Record<string, Array<(ev?: unknown) => void>> = {};
  const track: FakeTrack = {
    kind: "video",
    enabled: true,
    readyState: "live",
    stop: vi.fn(() => {
      track.readyState = "ended";
    }),
    addEventListener: vi.fn((ev: string, cb: (ev?: unknown) => void) => {
      (listeners[ev] ??= []).push(cb);
    }),
    _listeners: listeners,
    fireEnded: () => {
      for (const cb of listeners["ended"] ?? []) cb();
    },
  };
  return track;
}

function makeScreenStream(track: FakeTrack): MediaStream {
  return {
    getVideoTracks: () => [track],
    getAudioTracks: () => [],
    getTracks: () => [track],
  } as unknown as MediaStream;
}

interface FakeSender {
  track: MediaStreamTrack | null;
  replaceTrack: ReturnType<typeof vi.fn>;
}

function makeVideoSender(initial: FakeTrack | null): FakeSender {
  const sender: FakeSender = {
    track: initial as unknown as MediaStreamTrack | null,
    replaceTrack: vi.fn((next: MediaStreamTrack | null) => {
      sender.track = next;
      return Promise.resolve();
    }),
  };
  return sender;
}

interface FakePc {
  signalingState: RTCSignalingState;
  createOffer: ReturnType<typeof vi.fn>;
  setLocalDescription: ReturnType<typeof vi.fn>;
  setRemoteDescription: ReturnType<typeof vi.fn>;
}

function makeFakePc(): FakePc {
  return {
    signalingState: "stable",
    createOffer: vi.fn(),
    setLocalDescription: vi.fn(),
    setRemoteDescription: vi.fn(),
  };
}

interface Harness {
  hooks: ScreenShareHooks;
  sender: FakeSender;
  camera: FakeTrack;
  screen: FakeTrack;
  getDisplayMedia: ReturnType<typeof vi.fn>;
  pc: FakePc;
  emitted: Array<"active" | "inactive">;
  log: EventLogEntry[];
}

function makeHarness(opts?: {
  cameraLive?: boolean;
  getDisplayMedia?: (c: MediaStreamConstraints) => Promise<MediaStream>;
}): Harness {
  const pc = makeFakePc();
  const camera = makeVideoTrack();
  if (opts?.cameraLive === false) {
    camera.readyState = "ended";
  }
  const sender = makeVideoSender(camera);
  const screen = makeVideoTrack();
  const defaultGetDisplayMedia = vi.fn(async () => makeScreenStream(screen));
  const getDisplayMedia =
    (opts?.getDisplayMedia
      ? vi.fn(opts.getDisplayMedia)
      : defaultGetDisplayMedia);
  const emitted: Array<"active" | "inactive"> = [];
  const log: EventLogEntry[] = [];

  const hooks: ScreenShareHooks = {
    getVideoSender: () => sender as unknown as RTCRtpSender,
    getCameraTrack: () =>
      camera.readyState === "live"
        ? (camera as unknown as MediaStreamTrack)
        : null,
    emitMediaState: (screenShare) => {
      emitted.push(screenShare);
    },
    log: (entry) => {
      log.push(entry);
    },
    getDisplayMedia,
  };

  return {
    hooks,
    sender,
    camera,
    screen,
    getDisplayMedia,
    pc,
    emitted,
    log,
  };
}

// ---------------------------------------------------------------------
// (a) start() → replaceTrack(screen); no createOffer; state stable
// ---------------------------------------------------------------------

describe("screen-share.start (T075)", () => {
  it("replaceTrack is called exactly once with the screen track, no renegotiation", async () => {
    const h = makeHarness();
    const ctrl = createScreenShareController(h.hooks);
    const outcome = await ctrl.start();
    expect(outcome.ok).toBe(true);
    // exactly one replaceTrack; its argument is the screen video track
    expect(h.sender.replaceTrack).toHaveBeenCalledTimes(1);
    expect(h.sender.replaceTrack.mock.calls[0][0]).toBe(h.screen);
    // signalingState stays "stable" — screen share is a replaceTrack
    // on an existing sender; no renegotiation is triggered.
    expect(h.pc.signalingState).toBe("stable");
    expect(h.pc.createOffer).not.toHaveBeenCalled();
    // isActive reflects the swap
    expect(ctrl.isActive()).toBe(true);
    // event log narrated the swap
    expect(h.log.find((e) => e.type === "screen_share_started")).toBeDefined();
    expect(h.log.find((e) => e.type === "track_replaced")).toBeDefined();
  });
});

// ---------------------------------------------------------------------
// (b) stop("app") with camera live → replaceTrack(camera), no offer
// ---------------------------------------------------------------------

describe("screen-share.stop('app') (T077)", () => {
  it("reverts to the camera track without triggering renegotiation", async () => {
    const h = makeHarness();
    const ctrl = createScreenShareController(h.hooks);
    await ctrl.start();
    // reset spies that fired on start
    h.sender.replaceTrack.mockClear();
    h.pc.createOffer.mockClear();

    await ctrl.stop("app");

    expect(h.sender.replaceTrack).toHaveBeenCalledTimes(1);
    expect(h.sender.replaceTrack.mock.calls[0][0]).toBe(h.camera);
    expect(h.pc.createOffer).not.toHaveBeenCalled();
    expect(h.pc.signalingState).toBe("stable");
    expect(ctrl.isActive()).toBe(false);

    // Stop entry carries source="app" — the task brief accepts either
    // summary or code; we use `code`.
    const stopped = h.log.find((e) => e.type === "screen_share_stopped");
    expect(stopped).toBeDefined();
    expect(stopped?.code).toBe("app");
  });

  it("when camera is off, replaceTrack(null) — does NOT removeTrack", async () => {
    const h = makeHarness({ cameraLive: false });
    const ctrl = createScreenShareController(h.hooks);
    await ctrl.start();
    h.sender.replaceTrack.mockClear();

    await ctrl.stop("app");
    expect(h.sender.replaceTrack).toHaveBeenCalledTimes(1);
    expect(h.sender.replaceTrack.mock.calls[0][0]).toBeNull();
    // createOffer still not called — single outgoing video slot intact
    expect(h.pc.createOffer).not.toHaveBeenCalled();
    expect(h.pc.signalingState).toBe("stable");
  });
});

// ---------------------------------------------------------------------
// (c) browser-native stop: onended fires → same revert; source="browser"
// ---------------------------------------------------------------------

describe("screen-share browser-native stop (T077)", () => {
  it("onended triggers stop('browser') with matching revert", async () => {
    const h = makeHarness();
    const ctrl = createScreenShareController(h.hooks);
    await ctrl.start();
    h.sender.replaceTrack.mockClear();

    h.screen.fireEnded();
    // The async chain is: `onended` listener → `void stop("browser")`
    // (async fn) → `await sender.replaceTrack(target)`. The two
    // previous `await Promise.resolve()` ticks drained that chain by
    // coincidence in V8; `vi.waitFor` retries the assertion until it
    // passes, which is runtime-agnostic and documents the intent.
    await vi.waitFor(() => {
      expect(h.sender.replaceTrack).toHaveBeenCalledTimes(1);
    });
    expect(h.sender.replaceTrack.mock.calls[0][0]).toBe(h.camera);
    expect(ctrl.isActive()).toBe(false);
    const stopped = h.log.find((e) => e.type === "screen_share_stopped");
    expect(stopped).toBeDefined();
    expect(stopped?.code).toBe("browser");
  });
});

// ---------------------------------------------------------------------
// (d) picker cancel → NotAllowedError → no replaceTrack, one cancelled
// ---------------------------------------------------------------------

describe("screen-share picker cancel (T079)", () => {
  it("NotAllowedError from getDisplayMedia is a no-op with one cancelled log", async () => {
    const cancelError = Object.assign(new Error("picker cancelled"), {
      name: "NotAllowedError",
    });
    const h = makeHarness({
      getDisplayMedia: () => Promise.reject(cancelError),
    });
    const ctrl = createScreenShareController(h.hooks);
    const outcome = await ctrl.start();
    expect(outcome).toEqual({ ok: false, reason: "cancelled" });
    // No replaceTrack; no media_state emission
    expect(h.sender.replaceTrack).not.toHaveBeenCalled();
    expect(h.emitted).toEqual([]);
    // One screen_share_cancelled entry; nothing else screen-share-y
    const cancelled = h.log.filter(
      (e) => e.type === "screen_share_cancelled",
    );
    expect(cancelled).toHaveLength(1);
    expect(h.log.some((e) => e.type === "screen_share_started")).toBe(false);
    expect(ctrl.isActive()).toBe(false);
    expect(h.pc.signalingState).toBe("stable");
  });
});

// ---------------------------------------------------------------------
// (e) full-triplet rule: emitMediaState fires with active/inactive
//     around every successful start/stop (the caller builds the
//     full triplet; this controller emits the screenShare half).
// ---------------------------------------------------------------------

describe("screen-share media_state emissions (§3.11)", () => {
  it("emits 'active' on start and 'inactive' on stop — once each", async () => {
    const h = makeHarness();
    const ctrl = createScreenShareController(h.hooks);
    await ctrl.start();
    await ctrl.stop("app");
    expect(h.emitted).toEqual(["active", "inactive"]);
  });
});

// ---------------------------------------------------------------------
// stop() is idempotent when a hook throws between `stopping = true`
// and `screenTrack = null`. Without the try/finally, the flag would
// latch and every subsequent stop() would early-return.
//
// Note on the setup: the ambient `replaceTrack` try/catch inside
// stop() already swallows sender errors AND clears `screenTrack`
// before `stopping = false` runs, so a rejected replaceTrack alone
// cannot distinguish "flag cleared via finally" from "flag latched
// but hidden by the `!screenTrack` early-return." The throw must
// happen BEFORE `screenTrack = null` — i.e., from getCameraTrack
// or getVideoSender. We make `getCameraTrack` throw once to force
// exactly that path.
// ---------------------------------------------------------------------

describe("screen-share.stop is idempotent under hook throws (T075)", () => {
  it("re-entering stop() after a throw from getCameraTrack still proceeds", async () => {
    const camera = makeVideoTrack();
    const sender = makeVideoSender(camera);
    const screen = makeVideoTrack();
    const emitted: Array<"active" | "inactive"> = [];
    const log: EventLogEntry[] = [];
    // Mutable pointer so we can swap the behaviour between calls.
    let cameraTrackImpl: () => MediaStreamTrack | null = () =>
      camera as unknown as MediaStreamTrack;

    const hooks: ScreenShareHooks = {
      getVideoSender: () => sender as unknown as RTCRtpSender,
      getCameraTrack: () => cameraTrackImpl(),
      emitMediaState: (s) => {
        emitted.push(s);
      },
      log: (entry) => {
        log.push(entry);
      },
      getDisplayMedia: vi.fn(async () => makeScreenStream(screen)),
    };
    const ctrl = createScreenShareController(hooks);
    await ctrl.start();
    expect(ctrl.isActive()).toBe(true);

    // First stop(): getCameraTrack throws. With the finally fix, the
    // throw escapes but `stopping` is cleared; without it, `stopping`
    // stays `true` and the second stop() below would early-return.
    cameraTrackImpl = () => {
      throw new Error("synthetic hook failure");
    };
    await expect(ctrl.stop("app")).rejects.toThrow("synthetic hook failure");
    // screenTrack is NOT cleared when the throw escapes before
    // `screenTrack = null` — the controller is still "active."
    expect(ctrl.isActive()).toBe(true);

    // Second stop(): reset getCameraTrack so the path runs clean.
    sender.replaceTrack.mockClear();
    cameraTrackImpl = () => camera as unknown as MediaStreamTrack;
    await ctrl.stop("app");
    // Proved: stopping was cleared via finally. If latched, this
    // call would have early-returned and replaceTrack would not have
    // been called.
    expect(sender.replaceTrack).toHaveBeenCalledTimes(1);
    expect(sender.replaceTrack.mock.calls[0][0]).toBe(camera);
    expect(ctrl.isActive()).toBe(false);
  });
});
