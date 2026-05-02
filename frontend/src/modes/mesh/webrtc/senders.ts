// Local sender / track helpers (M9 / T069 + M10 / T077).
//
// Mic and camera toggles MUST flip the existing track's `enabled`
// property in place — they MUST NOT stop, replace, recreate, or
// renegotiate any sender. Per FR-033 + plan §11: the mesh has exactly
// 2 × (N − 1) outbound senders at steady state and we keep that
// invariant by reusing the same `MediaStreamTrack`s across every
// PairContext (data-model §B.3).
//
// `setLocalTrackEnabled` is a pure side-effecting helper — it doesn't
// touch React state, doesn't call `replaceTrack`, doesn't reach into
// any RTCPeerConnection. It also doesn't call getDisplayMedia (M9
// hard boundary; M10 owns screen-share).
//
// M10 / T077: screen-share MUST swap the outgoing video track via
// `RTCRtpSender.replaceTrack` ONLY. The sender-count invariant
// (`outgoingMediaSenders === 2 × activeLocalPairContexts`) MUST hold
// across every screen-share start/stop cycle — `addTransceiver` and
// `addTrack` are forbidden in the screen-share code path.

import type { MeshPairContext } from "./pairContext";

export type LocalTrackKind = "audio" | "video";

export interface LocalTrackToggleOutcome {
  readonly kind: LocalTrackKind;
  readonly enabled: boolean;
  // Number of tracks of `kind` whose enabled bit was actually flipped.
  // 0 means the stream was missing/empty or all tracks were already
  // in the requested state.
  readonly affected: number;
}

// setLocalTrackEnabled flips every track of `kind` on the supplied
// stream to `enabled`. Returns a small outcome record so the caller
// can log + branch without re-reading track state. Stream may be
// `null` (called before getUserMedia resolved); we return affected=0
// rather than throwing — the caller is responsible for guarding the
// UI button so this path stays diagnostic-only.
export function setLocalTrackEnabled(
  stream: MediaStream | null,
  kind: LocalTrackKind,
  enabled: boolean,
): LocalTrackToggleOutcome {
  if (!stream) return { kind, enabled, affected: 0 };
  const tracks =
    kind === "audio" ? stream.getAudioTracks() : stream.getVideoTracks();
  let affected = 0;
  for (const t of tracks) {
    if (t.enabled !== enabled) {
      t.enabled = enabled;
      affected += 1;
    }
  }
  return { kind, enabled, affected };
}

// readLocalTrackEnabled returns the OR of `track.enabled` over every
// track of `kind`. The fallback when the stream is missing or the
// kind is empty matches `setLocalTrackEnabled`'s default-on contract
// (mic + camera default to "on" until the user toggles).
export function readLocalTrackEnabled(
  stream: MediaStream | null,
  kind: LocalTrackKind,
): boolean {
  if (!stream) return true;
  const tracks =
    kind === "audio" ? stream.getAudioTracks() : stream.getVideoTracks();
  if (tracks.length === 0) return true;
  return tracks.some((t) => t.enabled);
}

// ---------------------------------------------------------------------
// M10 — sender-count invariant helpers (T077).
//
// A PairContext is "active" iff its lifecycle has not been closed (a
// closed pair has been torn down and its senders are no longer
// considered part of the mesh's outbound surface). Pre-negotiation
// states ("new", "creating-offer", etc.) still count: addTrack has
// already attached the senders even though the SDP exchange hasn't
// completed.
// ---------------------------------------------------------------------

export function isActiveLocalPairContext(ctx: MeshPairContext): boolean {
  return ctx.state !== "closed";
}

// findOutboundVideoSender — return the single outbound video sender
// for this PairContext, or null if none exists. Looks up via
// `pc.getSenders()` first (which reflects any prior `replaceTrack`
// calls), falling back to `ctx.senders` (the references captured at
// allocation time) so the lookup keeps working even after the sender's
// `track` was replaced with `null` (camera-off after a screen-share
// stop). The video sender is identified by its current track kind, or
// — when `track` is null — by being the non-audio sender in the
// captured `ctx.senders` array (audio senders carry the `dtmf` getter
// in real browsers; M10 doesn't depend on that and treats the
// remaining sender after audio identification as the video slot).
export function findOutboundVideoSender(
  ctx: MeshPairContext,
): RTCRtpSender | null {
  const candidates = readSenders(ctx);
  // Fast path — sender currently owns a non-null video track.
  for (const s of candidates) {
    const t = s.track;
    if (t && t.kind === "video") return s;
  }
  // Slow path — track is null (e.g. after replaceTrack(null) during a
  // screen-share stop with camera off). Identify the video slot by
  // elimination: the non-audio sender in the captured `ctx.senders`.
  if (ctx.senders.length === 0) return null;
  let videoSender: RTCRtpSender | null = null;
  for (const s of ctx.senders) {
    const t = s.track;
    if (t && t.kind === "audio") continue;
    if (t && t.kind === "video") return s;
    // track is null on this sender; tentatively treat as video. If we
    // see two such senders, prefer the second-position one (the mesh
    // attaches audio first then video in `getTracks()` order).
    videoSender = s;
  }
  return videoSender;
}

// findOutboundAudioSender — symmetric helper for the audio slot.
// Useful for invariant assertions; not used by the screen-share code
// path (which only mutates the video sender).
export function findOutboundAudioSender(
  ctx: MeshPairContext,
): RTCRtpSender | null {
  const candidates = readSenders(ctx);
  for (const s of candidates) {
    const t = s.track;
    if (t && t.kind === "audio") return s;
  }
  if (ctx.senders.length === 0) return null;
  for (const s of ctx.senders) {
    const t = s.track;
    if (t && t.kind === "audio") return s;
  }
  return null;
}

function readSenders(ctx: MeshPairContext): RTCRtpSender[] {
  // Test fakes may not implement getSenders; fall back to the
  // references captured at allocation time.
  const pc = ctx.pc as unknown as { getSenders?: () => RTCRtpSender[] };
  if (pc && typeof pc.getSenders === "function") {
    try {
      return pc.getSenders();
    } catch {
      // some fakes throw — fall through to the captured array.
    }
  }
  return Array.from(ctx.senders);
}

export interface MeshSenderCounts {
  readonly activeLocalPairContexts: number;
  readonly outgoingAudioSenderCount: number;
  readonly outgoingVideoSenderCount: number;
  readonly outgoingMediaSenders: number;
}

// countMeshSenders — derive the four counts the L14 / L16 invariant
// surface depends on. Pure: no side effects; can be called inside a
// React render or a vitest `expect` chain.
export function countMeshSenders(
  contexts: ReadonlyArray<MeshPairContext>,
): MeshSenderCounts {
  let active = 0;
  let audio = 0;
  let video = 0;
  for (const ctx of contexts) {
    if (!isActiveLocalPairContext(ctx)) continue;
    active += 1;
    if (findOutboundAudioSender(ctx)) audio += 1;
    if (findOutboundVideoSender(ctx)) video += 1;
  }
  return {
    activeLocalPairContexts: active,
    outgoingAudioSenderCount: audio,
    outgoingVideoSenderCount: video,
    outgoingMediaSenders: audio + video,
  };
}

// assertSenderCountInvariant — throws if the mesh's outbound surface
// drifts from `2 × activeLocalPairContexts`. Production calls this in
// dev / test only; the screen-share code path uses it to assert that
// `replaceTrack` did not change sender cardinality. The invariant is
// FR-070 + plan-prompt L16 + the explicit M10 boundary "must preserve
// the sender-count invariant".
export function assertSenderCountInvariant(
  contexts: ReadonlyArray<MeshPairContext>,
): MeshSenderCounts {
  const counts = countMeshSenders(contexts);
  const expected = 2 * counts.activeLocalPairContexts;
  if (counts.outgoingMediaSenders !== expected) {
    throw new Error(
      `mesh sender-count invariant violated: outgoingMediaSenders=${counts.outgoingMediaSenders}, expected ${expected} (= 2 × activeLocalPairContexts ${counts.activeLocalPairContexts})`,
    );
  }
  return counts;
}
