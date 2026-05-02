// MeshControls (M9 / T069 + T070) — mic + camera toggles.
//
// Behavior:
//   - Each click flips `track.enabled` on the local stream (no
//     replaceTrack, no createOffer, no setLocalDescription, no PC
//     recreation).
//   - Each click also dispatches the local-media reducer + sends
//     EXACTLY ONE `pair_media_state` to /ws/mesh. The server fans out
//     N − 1 envelopes (FR-032). The client never iterates pairs.
//   - Buttons are disabled until the local participant is media-ready
//     so a stray click before `getUserMedia` resolves can't force a
//     no-op send.
//
// M9 hard boundary:
//   - No screen-share button. The triple's `screenShare` field stays
//     "inactive" — M10 owns getDisplayMedia.
//   - No renegotiation. No `pc.createOffer`. No new RTCPeerConnection.

import { useEffect, useState } from "react";
import { subscribeLocalStream } from "../webrtc/mediaAcquisition";
import { setLocalTrackEnabled } from "../webrtc/senders";
import { useMeshDispatch, useMeshState } from "../state";
import { useMeshSignalingClient } from "../signaling/provider";
import { makeMeshEventEntry } from "../state/eventLog";
import {
  MESH_CONTRACT_VERSION,
  type CameraState,
  type MicState,
  type PairMediaStatePayload,
  type ScreenShareState,
} from "../signaling/schema";

interface PairMediaStateSnapshot {
  readonly microphone: MicState;
  readonly camera: CameraState;
  readonly screenShare: ScreenShareState;
}

export function MeshControls() {
  const dispatch = useMeshDispatch();
  const state = useMeshState();
  const client = useMeshSignalingClient();
  const [hasStream, setHasStream] = useState<boolean>(false);

  useEffect(() => {
    return subscribeLocalStream((s) => {
      setHasStream(s !== null);
    });
  }, []);

  const localPeerId = state.local.peerId;
  const roomId = state.local.roomId;
  const fsm = state.local.fsm;
  const ready = fsm === "media-ready" || fsm === "in-room";
  const canToggle = ready && hasStream && Boolean(roomId) && Boolean(localPeerId);

  const mic = state.localMedia.microphone;
  const camera = state.localMedia.camera;
  const screenShare = state.localMedia.screenShare;

  const sendMediaState = (snapshot: PairMediaStateSnapshot) => {
    if (!roomId) return;
    const payload: PairMediaStatePayload = {
      microphone: snapshot.microphone,
      camera: snapshot.camera,
      // M9 must not start screen sharing — pass through whatever the
      // local slice currently holds (always "inactive" until M10).
      screenShare: snapshot.screenShare,
    };
    try {
      client.send({
        v: MESH_CONTRACT_VERSION,
        type: "pair_media_state",
        roomId,
        payload,
      });
    } catch (err) {
      dispatch({
        type: "MESH_EVENT_APPEND",
        entry: makeMeshEventEntry({
          scope: "local",
          type: "signaling_error",
          summary: `failed to send pair_media_state: ${
            (err as Error).message ?? "unknown"
          }`,
        }),
      });
      return;
    }
    dispatch({
      type: "MESH_EVENT_APPEND",
      entry: makeMeshEventEntry({
        scope: "room",
        type: "mesh_media_state_sent",
        summary:
          "pair_media_state sent (signaling metadata path; server fan-out, not media path)",
        detail: {
          transport: "signaling",
          path: "metadata",
        },
      }),
    });
  };

  const onMicToggle = () => {
    if (!canToggle) return;
    const next: MicState = mic === "on" ? "off" : "on";
    setLocalTrackEnabled(currentLocalStream(), "audio", next === "on");
    dispatch({ type: "MESH_LOCAL_MEDIA_MIC_TOGGLED", next });
    dispatch({
      type: "MESH_EVENT_APPEND",
      entry: makeMeshEventEntry({
        scope: "local",
        type: "mesh_media_local_toggled",
        summary: `microphone toggled → ${next}`,
        detail: { kind: "microphone", next },
      }),
    });
    sendMediaState({ microphone: next, camera, screenShare });
  };

  const onCameraToggle = () => {
    if (!canToggle) return;
    const next: CameraState = camera === "on" ? "off" : "on";
    setLocalTrackEnabled(currentLocalStream(), "video", next === "on");
    dispatch({ type: "MESH_LOCAL_MEDIA_CAMERA_TOGGLED", next });
    dispatch({
      type: "MESH_EVENT_APPEND",
      entry: makeMeshEventEntry({
        scope: "local",
        type: "mesh_media_local_toggled",
        summary: `camera toggled → ${next}`,
        detail: { kind: "camera", next },
      }),
    });
    sendMediaState({ microphone: mic, camera: next, screenShare });
  };

  return (
    <section
      className="mesh-controls"
      aria-labelledby="mesh-controls-heading"
      data-testid="mesh-controls"
    >
      <h2 id="mesh-controls-heading">Local media controls</h2>
      <div className="mesh-controls__row">
        <button
          type="button"
          onClick={onMicToggle}
          disabled={!canToggle}
          aria-pressed={mic === "on"}
          data-testid="mesh-controls-mic"
          data-state={mic}
        >
          mic: {mic}
        </button>
        <button
          type="button"
          onClick={onCameraToggle}
          disabled={!canToggle}
          aria-pressed={camera === "on"}
          data-testid="mesh-controls-camera"
          data-state={camera}
        >
          camera: {camera}
        </button>
        <span
          className="mesh-controls__indicator"
          data-testid="mesh-controls-screen-share"
          data-state={screenShare}
          aria-label={`screen share ${screenShare}`}
        >
          screen share: {screenShare}
        </span>
      </div>
    </section>
  );
}

// Helper to read the current published stream synchronously without
// re-subscribing on every render. The mediaAcquisition module owns the
// authoritative reference; we mirror it here via the subscribe-and-cache
// pattern so the click handler doesn't need to be async.
let cachedLocalStream: MediaStream | null = null;
let cacheSubscribed = false;
function ensureCacheSubscribed() {
  if (cacheSubscribed) return;
  cacheSubscribed = true;
  subscribeLocalStream((s) => {
    cachedLocalStream = s;
  });
}
function currentLocalStream(): MediaStream | null {
  ensureCacheSubscribed();
  return cachedLocalStream;
}
