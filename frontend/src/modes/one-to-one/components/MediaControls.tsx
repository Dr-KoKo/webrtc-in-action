// MediaControls — Phase 10 (T071 / T072, contract §3.11, FR-014a).
//
// Two buttons (mic, camera) that toggle the local track's `enabled`
// flag and announce the new full triplet via `media_state`. Flipping
// `track.enabled` is a runtime mute — it does NOT trigger SDP
// renegotiation (research §4 + plan Phase 10 DoD); the regression test
// in `tests/unit/media-controls.spec.ts` pins this invariant.
//
// Disabled state: both buttons are disabled when there is no local
// stream (T071 DoD). Clicking with a stream but before pairing still
// flips `track.enabled` locally so the user's own toggle renders
// immediately; the outbound `media_state` is only emitted once the
// session reaches `connecting` or `connected` (contract §3.11 wording:
// "callPhase SHOULD be connected; the server MAY relay during
// negotiating"). The server rejects earlier sends with `malformed`, so
// we don't bother emitting them.

import { useCallback } from "react";
import { useDispatch, useRootState } from "../state";
import { makeEventLogEntry } from "../state/event-log";
import type { MediaKind } from "../state/media";
import { useSignalingClient } from "../signaling/provider";
import { CONTRACT_VERSION } from "../types/contract";
import { useLocalMedia } from "../webrtc/local-media-provider";
import {
  readLocalMediaTriplet,
  setLocalTrackEnabled,
} from "@/shared/webrtc/media-acquisition";

export function MediaControls() {
  const { getStream, hasStream, streamVersion } = useLocalMedia();
  const dispatch = useDispatch();
  const client = useSignalingClient();
  const { media, session } = useRootState();
  // streamVersion is referenced so MediaControls re-renders whenever
  // the live stream is acquired / released, flipping `disabled` on the
  // buttons without the caller having to manually re-read.
  void streamVersion;

  const disabled = !hasStream;
  const micOn = media.local.microphone === "on";
  const camOn = media.local.camera === "on";

  const onToggle = useCallback(
    (kind: MediaKind) => {
      const stream = getStream();
      if (!stream) return;
      const current =
        kind === "microphone" ? media.local.microphone : media.local.camera;
      const nextEnabled = current !== "on";
      setLocalTrackEnabled(stream, kind, nextEnabled);
      const triplet = readLocalMediaTriplet(stream, media.local.screenShare);
      dispatch({ type: "LOCAL_MEDIA_STATE_SET", triplet });

      // Only emit `media_state` once the session permits it per
      // contract §3.11. Earlier sends would be rejected by the server
      // with `malformed`, which would just noise the event log.
      const canEmit =
        session.roomId !== null &&
        (session.session === "connecting" || session.session === "connected");
      if (!canEmit) return;
      try {
        client.send({
          v: CONTRACT_VERSION,
          type: "media_state",
          roomId: session.roomId as string,
          payload: triplet,
        });
        dispatch({
          type: "EVENT_LOG_APPEND",
          entry: makeEventLogEntry({
            type: "media_state",
            direction: "local",
            summary: `media_state sent (mic=${triplet.microphone}, camera=${triplet.camera}, screen=${triplet.screenShare})`,
            transport: "signaling",
          }),
        });
      } catch {
        // Best-effort: the WS may have just closed. The server will
        // reconcile on the next transition.
      }
    },
    [
      client,
      dispatch,
      getStream,
      media.local.camera,
      media.local.microphone,
      media.local.screenShare,
      session.roomId,
      session.session,
    ],
  );

  return (
    <section aria-labelledby="media-controls-heading" className="media-controls">
      <h2 id="media-controls-heading">Media controls</h2>
      <div className="media-controls__row">
        <button
          type="button"
          data-testid="mic-toggle"
          aria-pressed={micOn}
          disabled={disabled}
          onClick={() => onToggle("microphone")}
        >
          {micOn ? "Mute mic" : "Unmute mic"}
        </button>
        <button
          type="button"
          data-testid="camera-toggle"
          aria-pressed={camOn}
          disabled={disabled}
          onClick={() => onToggle("camera")}
        >
          {camOn ? "Turn camera off" : "Turn camera on"}
        </button>
      </div>
      <dl className="media-controls__summary">
        <dt>Local</dt>
        <dd data-testid="media-controls-local">
          mic {media.local.microphone}, camera {media.local.camera}, screen{" "}
          {media.local.screenShare}
        </dd>
        <dt>Remote</dt>
        <dd data-testid="media-controls-remote">
          {media.remote
            ? `mic ${media.remote.microphone}, camera ${media.remote.camera}, screen ${media.remote.screenShare}`
            : "unknown"}
        </dd>
      </dl>
    </section>
  );
}
