// Local media acquisition (Phase 6 T044 / T048).
//
// Wraps `navigator.mediaDevices.getUserMedia({audio, video})` and maps
// browser rejections to the contract's `media_failed.payload.reason`
// enum (§3.6). MVP rule: both audio AND video are required — we do not
// gracefully fall back to audio-only or video-only. If the user's
// environment cannot satisfy both, the attempt fails.
//
// The function never throws into the caller — it returns a tagged
// result so reducers / lifecycle hooks can branch without try/catch.
// `stopTracks` is the counterpart used by Leave cleanup (data-model
// §C.5 Path A, local-tracks portion).

import type { MediaFailedMessage } from "../signaling/schema";

export type MediaFailedReason =
  MediaFailedMessage["payload"]["reason"];

export type AcquireOutcome =
  | { ok: true; stream: MediaStream }
  | { ok: false; reason: MediaFailedReason; detail?: string };

export interface AcquireLocalMediaOptions {
  // Allow tests to inject a fake getUserMedia. In production this
  // defaults to `navigator.mediaDevices.getUserMedia`.
  getUserMedia?: (
    constraints: MediaStreamConstraints,
  ) => Promise<MediaStream>;
  constraints?: MediaStreamConstraints;
}

const DEFAULT_CONSTRAINTS: MediaStreamConstraints = {
  audio: true,
  video: true,
};

export async function acquireLocalMedia(
  opts: AcquireLocalMediaOptions = {},
): Promise<AcquireOutcome> {
  const constraints = opts.constraints ?? DEFAULT_CONSTRAINTS;
  const fn =
    opts.getUserMedia ??
    (typeof navigator !== "undefined" && navigator.mediaDevices
      ? navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
      : undefined);

  if (!fn) {
    return {
      ok: false,
      reason: "other",
      detail: "navigator.mediaDevices.getUserMedia unavailable",
    };
  }

  try {
    const stream = await fn(constraints);
    return { ok: true, stream };
  } catch (err) {
    return { ok: false, ...classifyMediaError(err) };
  }
}

export function classifyMediaError(err: unknown): {
  reason: MediaFailedReason;
  detail?: string;
} {
  // Per WebRTC spec, getUserMedia rejects with a DOMException whose
  // `name` identifies the failure class. Different browsers historically
  // used different names; we accept the modern set plus a few aliases.
  const name = extractErrorName(err);
  const message = extractErrorMessage(err);
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
    case "PermissionDeniedError": // legacy Chrome/Firefox
      return withDetail("permission_denied", message);
    case "NotFoundError":
    case "DevicesNotFoundError": // legacy Chrome
      return withDetail("device_not_found", message);
    case "NotReadableError":
    case "TrackStartError": // legacy Chrome
    case "AbortError": // hardware/driver aborted
      return withDetail("device_in_use", message);
    default:
      return withDetail("other", message ?? name ?? "unknown");
  }
}

function withDetail(
  reason: MediaFailedReason,
  detail: string | undefined,
): { reason: MediaFailedReason; detail?: string } {
  return detail ? { reason, detail } : { reason };
}

function extractErrorName(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "name" in err) {
    const n = (err as { name: unknown }).name;
    if (typeof n === "string") return n;
  }
  return undefined;
}

function extractErrorMessage(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "message" in err) {
    const m = (err as { message: unknown }).message;
    if (typeof m === "string" && m.length > 0) return m;
  }
  return undefined;
}

// Stop every track on a MediaStream. Safe to call on a stream whose
// tracks are already stopped (the browser no-ops). Clears the source
// so the browser's device-in-use indicator clears within a few hundred
// ms (SC-005 requires ≤ 5 s).
export function stopTracks(stream: MediaStream | null | undefined): void {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // ignore — track already ended
    }
  }
}
