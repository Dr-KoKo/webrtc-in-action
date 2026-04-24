// ScreenShareButton — Phase 11 (T076, FR-014a, FR-017, SC-007).
//
// One button that flips between "Share screen" and "Stop sharing"
// based on the current local screen-share triplet value. Disabled
// whenever `session.session !== "connected"` OR no outgoing video
// sender is available — screen share rides the video sender, not the
// DataChannel, so it is NOT gated on DC state (per task brief).
//
// The heavy lifting lives in `webrtc/screen-share.ts`. This component
// is the glue between that controller and the reducer / signaling
// client: it wires the three hooks (getVideoSender, getCameraTrack,
// emitMediaState) and the event-log sink, then calls start / stop
// from the click handler.

import { useCallback, useMemo, useRef } from "react";
import { useDispatch, useRootState } from "../state";
import { useSignalingClient } from "../signaling/provider";
import { useLocalMedia } from "../webrtc/local-media-provider";
import { usePeerConnection } from "../webrtc/peer-connection-provider";
import {
  createScreenShareController,
  type ScreenShareController,
  type ScreenShareHooks,
} from "../webrtc/screen-share";
import { readLocalMediaTriplet } from "../webrtc/media-acquisition";
import { makeEventLogEntry } from "../state/event-log";
import { CONTRACT_VERSION } from "../types/contract";

export function ScreenShareButton() {
  const dispatch = useDispatch();
  const client = useSignalingClient();
  const { media, session } = useRootState();
  const { getStream } = useLocalMedia();
  const { getHandle } = usePeerConnection();

  // The controller is stateful (screen track, re-entry guard) and must
  // persist across renders. Store a single instance in a ref.
  const controllerRef = useRef<ScreenShareController | null>(null);

  // Read-only references used by the controller hooks. We capture them
  // in refs so the controller — created once — always reads the latest
  // values without being recreated on every render.
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const mediaLocalRef = useRef(media.local);
  mediaLocalRef.current = media.local;
  const getStreamRef = useRef(getStream);
  getStreamRef.current = getStream;
  const getHandleRef = useRef(getHandle);
  getHandleRef.current = getHandle;
  const clientRef = useRef(client);
  clientRef.current = client;
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;

  const controller = useMemo<ScreenShareController>(() => {
    if (controllerRef.current) return controllerRef.current;
    const hooks: ScreenShareHooks = {
      getVideoSender: () => {
        const handle = getHandleRef.current();
        if (!handle) return null;
        const senders = handle.pc.getSenders();
        const videoSender = senders.find(
          (s) => s.track?.kind === "video",
        );
        if (videoSender) return videoSender;
        // Fallback: a sender whose track has not been attached yet.
        // attachLocalTracks runs before this component is usable, but
        // be defensive.
        return senders.find((s) => s.track === null) ?? null;
      },
      getCameraTrack: () => {
        const stream = getStreamRef.current();
        if (!stream) return null;
        // Return the first live video track regardless of `enabled`.
        // MediaControls mutes by flipping `track.enabled = false`, but
        // the track stays live. `replaceTrack(liveMutedTrack)` is valid
        // WebRTC — the sender carries the track forward and frames are
        // blacked out while `enabled` is false. If we filtered on
        // `enabled` here, stop-after-mute would pass `null` to
        // `replaceTrack` and the sender would be permanently
        // track-less; a subsequent `MediaControls` unmute would only
        // flip a detached track's flag and the camera would stay dead
        // to the remote until leave/rejoin.
        for (const t of stream.getVideoTracks()) {
          if (t.readyState === "live") return t;
        }
        return null;
      },
      emitMediaState: (screenShare) => {
        const stream = getStreamRef.current();
        const triplet = readLocalMediaTriplet(stream, screenShare);
        dispatchRef.current({ type: "LOCAL_MEDIA_STATE_SET", triplet });
        const s = sessionRef.current;
        const canEmit =
          s.roomId !== null &&
          (s.session === "connecting" || s.session === "connected");
        if (!canEmit) return;
        try {
          clientRef.current.send({
            v: CONTRACT_VERSION,
            type: "media_state",
            roomId: s.roomId as string,
            payload: triplet,
          });
          dispatchRef.current({
            type: "EVENT_LOG_APPEND",
            entry: makeEventLogEntry({
              type: "media_state",
              direction: "local",
              summary: `media_state sent (mic=${triplet.microphone}, camera=${triplet.camera}, screen=${triplet.screenShare})`,
              transport: "signaling",
            }),
          });
        } catch {
          // Best-effort; the WS may have closed. The server will
          // reconcile on the next transition.
        }
      },
      log: (entry) => {
        dispatchRef.current({ type: "EVENT_LOG_APPEND", entry });
      },
    };
    controllerRef.current = createScreenShareController(hooks);
    return controllerRef.current;
  }, []);

  const active = media.local.screenShare === "active";
  // Visible gate: only the connected phase. The controller itself
  // refuses to start if no video sender is present (e.g., PC not yet
  // built), which doubles as the "outgoing video sender unavailable"
  // condition the task brief calls out.
  const disabled = session.session !== "connected";

  const onClick = useCallback(() => {
    void (async () => {
      if (controller.isActive()) {
        await controller.stop("app");
      } else {
        await controller.start();
      }
    })();
  }, [controller]);

  return (
    <section
      aria-labelledby="screen-share-heading"
      className="screen-share"
    >
      <h2 id="screen-share-heading">Screen share</h2>
      <button
        type="button"
        data-testid="screen-share-toggle"
        aria-pressed={active}
        disabled={disabled}
        onClick={onClick}
      >
        {active ? "Stop sharing" : "Share screen"}
      </button>
    </section>
  );
}
