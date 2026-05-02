// Local sender / track helpers (M9 / T069).
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
