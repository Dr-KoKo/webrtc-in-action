// Screen-share controller — Phase 11 (T075 / T077 / T079).
//
// Wraps `navigator.mediaDevices.getDisplayMedia` + one
// `RTCRtpSender.replaceTrack` call so a connected peer can swap the
// outgoing video track between camera and screen WITHOUT renegotiation
// (FR-017 "single outgoing video slot" + research §4 — `replaceTrack`
// on an existing sender preserves the SDP transceiver, so
// `signalingState` stays `stable`).
//
// Stop comes from two sources and both hit one code path:
//   - `stop("app")` — user clicked the in-app Stop button.
//   - `stop("browser")` — browser native "Stop sharing" banner. We
//     detect this via `screenTrack.onended`; we do NOT sniff
//     `mediaDevices` events or poll (one source of truth per stop).
//
// Picker cancellation (`getDisplayMedia` rejects with
// `NotAllowedError`) is a no-op except for a log line — no state
// mutation, never throws into React (T079).
//
// The module is intentionally side-effect-light: it does not import
// `LocalMediaProvider` or the reducer. The caller injects hooks:
//   - `getVideoSender()` — returns the outgoing video `RTCRtpSender`
//     for this pairing, or null if none is available (pre-PC, post-
//     close). Refusal to start is the caller's call.
//   - `getCameraTrack()` — returns the live camera track to revert to
//     on stop, or null when camera is currently off. Null means we
//     `replaceTrack(null)` and the remote's existing camera-off
//     indicator renders (do NOT removeTrack — that triggers
//     renegotiation).
//   - `emitMediaState(screenShare)` — the controller calls this so
//     the caller can dispatch LOCAL_MEDIA_STATE_SET with the full
//     triplet and send the canonical `media_state` envelope. Phase 10
//     already owns that send path; this module is deliberately blind
//     to the triplet's mic/camera fields.
//   - `log(entry)` — event-log sink. Summaries carry only enum tags;
//     raw track ids / display-surface labels / URLs are never stored
//     (NFR-006 / Principle VIII).
//   - `getDisplayMedia` — test seam. Defaults to
//     `navigator.mediaDevices.getDisplayMedia` in production.

import { makeEventLogEntry, type EventLogEntry } from "../state/event-log";

export type ScreenShareStopSource = "app" | "browser";

export type ScreenShareStartOutcome =
  | { ok: true }
  | { ok: false; reason: "cancelled" | "no-video-sender" | "no-display-media" | "error"; detail?: string };

export interface ScreenShareController {
  /** Start screen share: getDisplayMedia({video:true}) → replaceTrack. */
  start(): Promise<ScreenShareStartOutcome>;
  /** Stop: replaceTrack(camera-or-null). One code path for both sources. */
  stop(source: ScreenShareStopSource): Promise<void>;
  /** True when a screen track is currently wired to the sender. */
  isActive(): boolean;
}

export interface ScreenShareHooks {
  /**
   * The outgoing video `RTCRtpSender` for the current pairing, or null
   * if there is no active PC. We never create a sender ourselves; start
   * fails cleanly when none is available.
   */
  getVideoSender(): RTCRtpSender | null;
  /**
   * The live camera track to revert to on stop. Null means camera is
   * currently off; the stop path will `replaceTrack(null)` and the
   * remote's existing camera-off indicator renders.
   */
  getCameraTrack(): MediaStreamTrack | null;
  /**
   * Called after every successful start or stop so the caller can
   * dispatch LOCAL_MEDIA_STATE_SET with the full triplet and send the
   * canonical `media_state` envelope. The triplet's microphone/camera
   * fields are the caller's concern; this module just reports
   * `screenShare`.
   */
  emitMediaState(screenShare: "active" | "inactive"): void;
  /** Event-log sink. Must accept already-shaped entries. */
  log(entry: EventLogEntry): void;
  /** Test seam; defaults to navigator.mediaDevices.getDisplayMedia. */
  getDisplayMedia?: (
    constraints: MediaStreamConstraints,
  ) => Promise<MediaStream>;
}

export function createScreenShareController(
  hooks: ScreenShareHooks,
): ScreenShareController {
  let screenTrack: MediaStreamTrack | null = null;
  let screenStream: MediaStream | null = null;
  // Guard re-entry: browser `onended` can race an in-flight `stop("app")`.
  let stopping = false;

  async function start(): Promise<ScreenShareStartOutcome> {
    if (screenTrack) {
      return { ok: true };
    }
    const sender = hooks.getVideoSender();
    if (!sender) {
      return { ok: false, reason: "no-video-sender" };
    }

    const getter =
      hooks.getDisplayMedia ??
      (typeof navigator !== "undefined" && navigator.mediaDevices
        ? navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices)
        : undefined);
    if (!getter) {
      return { ok: false, reason: "no-display-media" };
    }

    let stream: MediaStream;
    try {
      // MVP: video only. Adding audio silently changes the privacy
      // surface of the feature; out of scope for this phase.
      stream = await getter({ video: true });
    } catch (err) {
      if (isNotAllowedError(err)) {
        // T079 — picker cancellation. No state change; one log entry.
        hooks.log(
          makeEventLogEntry({
            type: "screen_share_cancelled",
            direction: "local",
            summary: "screen share cancelled (picker)",
          }),
        );
        return { ok: false, reason: "cancelled" };
      }
      const name = errorName(err);
      hooks.log(
        makeEventLogEntry({
          type: "screen_share_cancelled",
          direction: "local",
          summary: `screen share failed (${name ?? "unknown"})`,
          ...(name !== undefined ? { code: name } : {}),
        }),
      );
      return { ok: false, reason: "error", ...withDetail(err) };
    }

    const [videoTrack] = stream.getVideoTracks();
    if (!videoTrack) {
      // getDisplayMedia fulfilled with no video track — defensive; not
      // observed in practice but contract-wise we must not call
      // replaceTrack with `undefined`.
      stopStreamTracks(stream);
      return { ok: false, reason: "error", detail: "no_video_track" };
    }

    screenTrack = videoTrack;
    screenStream = stream;

    try {
      await sender.replaceTrack(videoTrack);
    } catch (err) {
      screenTrack = null;
      screenStream = null;
      stopStreamTracks(stream);
      hooks.log(
        makeEventLogEntry({
          type: "screen_share_cancelled",
          direction: "local",
          summary: `replaceTrack(screen) failed (${errorName(err) ?? "unknown"})`,
          code: "replace_track_failed",
        }),
      );
      return { ok: false, reason: "error", ...withDetail(err) };
    }

    // Browser-native stop: the "Stop sharing" banner ends the track.
    // This is the ONLY signal we use; we do not poll or subscribe to
    // `mediaDevices` events (one source of truth per stop).
    videoTrack.addEventListener("ended", () => {
      // Re-entry guard — if `stop("app")` already ran and cleared the
      // track, skip. Otherwise route through the same stop path with
      // source="browser".
      if (!screenTrack || screenTrack !== videoTrack) return;
      void stop("browser");
    });

    hooks.log(
      makeEventLogEntry({
        type: "screen_share_started",
        direction: "local",
        summary: "screen share started",
      }),
    );
    hooks.log(
      makeEventLogEntry({
        type: "track_replaced",
        direction: "local",
        summary: "video sender: camera → screen",
      }),
    );
    hooks.emitMediaState("active");
    return { ok: true };
  }

  async function stop(source: ScreenShareStopSource): Promise<void> {
    if (!screenTrack || stopping) return;
    stopping = true;
    const sender = hooks.getVideoSender();
    const cameraTrack = hooks.getCameraTrack();
    const target = cameraTrack && cameraTrack.readyState === "live"
      ? cameraTrack
      : null;
    try {
      if (sender) {
        // replaceTrack(null) is legal and does NOT trigger renegotiation
        // (research §4). The transceiver stays in the same SDP slot;
        // only the payload stops flowing. Remote's existing camera-off
        // indicator renders unchanged.
        await sender.replaceTrack(target);
      }
    } catch (err) {
      hooks.log(
        makeEventLogEntry({
          type: "screen_share_stopped",
          direction: "local",
          summary: `replaceTrack(camera) failed (${errorName(err) ?? "unknown"})`,
          code: "replace_track_failed",
        }),
      );
      // Fall through: we still need to release the screen track + emit
      // media_state so the remote indicator flips within SC-007.
    }

    const endingTrack = screenTrack;
    const endingStream = screenStream;
    screenTrack = null;
    screenStream = null;

    // Release the screen capture so the browser clears the per-tab /
    // OS "sharing" affordance. Safe on tracks already ended by the
    // browser-native stop path.
    try {
      endingTrack.stop();
    } catch {
      // idempotent
    }
    if (endingStream) {
      stopStreamTracks(endingStream);
    }

    hooks.log(
      makeEventLogEntry({
        type: "track_replaced",
        direction: "local",
        summary: target ? "video sender: screen → camera" : "video sender: screen → none",
      }),
    );
    hooks.log(
      makeEventLogEntry({
        type: "screen_share_stopped",
        direction: "local",
        summary: `screen share stopped (source=${source})`,
        code: source,
      }),
    );
    hooks.emitMediaState("inactive");
    stopping = false;
  }

  return {
    start,
    stop,
    isActive: () => screenTrack !== null,
  };
}

function isNotAllowedError(err: unknown): boolean {
  return errorName(err) === "NotAllowedError";
}

function errorName(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "name" in err) {
    const n = (err as { name: unknown }).name;
    if (typeof n === "string") return n;
  }
  return undefined;
}

function withDetail(err: unknown): { detail?: string } {
  if (typeof err === "object" && err !== null && "message" in err) {
    const m = (err as { message: unknown }).message;
    if (typeof m === "string" && m.length > 0) return { detail: m };
  }
  return {};
}

function stopStreamTracks(stream: MediaStream): void {
  for (const t of stream.getTracks()) {
    try {
      t.stop();
    } catch {
      // ignore
    }
  }
}
