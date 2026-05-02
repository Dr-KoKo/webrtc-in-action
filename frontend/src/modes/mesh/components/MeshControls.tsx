// MeshControls (M9 / T069 + T070; M10 / T075 + T076 add screen share).
//
// Behavior:
//   - mic / camera click flips `track.enabled` in place (no replaceTrack,
//     no createOffer, no PC recreation) and emits ONE `pair_media_state`.
//   - Share screen click → getDisplayMedia → replaceTrack across every
//     active outbound video sender → emit ONE `pair_media_state`.
//   - Stop sharing click → replaceTrack(cameraTrack ?? null) across every
//     tracked outbound video sender → emit ONE `pair_media_state`.
//   - Browser-native "Stop sharing" (`screenTrack.onended`) drives the
//     same cleanup path via the shared screen-share controller, so
//     remote tiles update within ~2 s without an in-app click.
//   - Buttons are disabled until the local participant is media-ready
//     so a stray click before `getUserMedia` resolves cannot force a
//     no-op send.
//
// M10 hard boundary:
//   - No `addTransceiver`, no `addTrack` in the screen-share path.
//   - No room-level current-sharer concept — multiple participants MAY
//     share concurrently. Stopping one peer's share does NOT mutate
//     another peer's screen-share state.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  publishLocalStream,
  subscribeLocalStream,
} from "../webrtc/mediaAcquisition";
import { setLocalTrackEnabled } from "../webrtc/senders";
import { useMeshDispatch, useMeshState, type MeshRootState } from "../state";
import {
  useMeshPairManager,
  useMeshSignalingClient,
} from "../signaling/provider";
import { makeMeshEventEntry } from "../state/eventLog";
import {
  MESH_CONTRACT_VERSION,
  type CameraState,
  type MicState,
  type PairMediaStatePayload,
  type ScreenShareState,
} from "../signaling/schema";
import {
  createScreenShareController,
  getActiveScreenTrack,
  type ScreenShareController,
} from "../webrtc/screenShare";
import type { MeshPairManager } from "../webrtc/pairManager";
import { createMeshLeavePath } from "../webrtc/leavePath";

interface PairMediaStateSnapshot {
  readonly microphone: MicState;
  readonly camera: CameraState;
  readonly screenShare: ScreenShareState;
}

export function MeshControls() {
  const dispatch = useMeshDispatch();
  const state = useMeshState();
  const client = useMeshSignalingClient();
  const pairManager = useMeshPairManager();
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

  // Refs keep the screen-share controller's getters fresh across
  // renders without recreating the controller each time. The
  // controller closure is built once at first render that produces
  // a usable signaling client.
  const stateRef = useRef<MeshRootState>(state);
  stateRef.current = state;
  const pairManagerRef = useRef<MeshPairManager | null>(pairManager);
  pairManagerRef.current = pairManager;
  const sendRef = useRef(client.send.bind(client));
  sendRef.current = client.send.bind(client);

  const controllerRef = useRef<ScreenShareController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = createScreenShareController({
      dispatch,
      send: (m) => sendRef.current(m),
      getRoomId: () => stateRef.current.local.roomId ?? null,
      getPairContexts: () => pairManagerRef.current?.listContexts() ?? [],
      getCameraTrack: () => {
        const s = currentLocalStream();
        if (!s) return null;
        const tracks = s.getVideoTracks();
        return tracks[0] ?? null;
      },
      getCameraState: () => stateRef.current.localMedia.camera,
      getMicState: () => stateRef.current.localMedia.microphone,
    });
  }
  // Tear down the controller (release any active screen track) on
  // unmount. The store's `MESH_LOCAL_MEDIA_RESET` already takes care of
  // the React state on Leave; this drops the underlying MediaStream.
  useEffect(() => {
    return () => {
      controllerRef.current?.dispose();
    };
  }, []);

  const sendMediaState = (snapshot: PairMediaStateSnapshot) => {
    if (!roomId) return;
    const payload: PairMediaStatePayload = {
      microphone: snapshot.microphone,
      camera: snapshot.camera,
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

  const onShareScreenClick = () => {
    if (!canToggle) return;
    const ctrl = controllerRef.current;
    if (!ctrl) return;
    if (screenShare === "active") {
      void ctrl.stop("app");
    } else {
      void ctrl.start();
    }
  };

  // M12 / T089 — Path A graceful Leave. Idempotent at the orchestrator
  // gate (createMeshLeavePath returns a singleton run/hasRun pair) and
  // at the FSM gate (the reducer drops MESH_LEAVE_REQUESTED while
  // already leaving / left). The Leave button is enabled whenever the
  // user holds an admitted slot or is mid-flight; pre-join clicks are a
  // no-op via the FSM guard.
  const leavePathRef = useRef<ReturnType<typeof createMeshLeavePath> | null>(
    null,
  );
  if (leavePathRef.current === null) {
    leavePathRef.current = createMeshLeavePath({
      dispatch,
      send: (m) => sendRef.current(m),
      isSocketOpen: () => client.getTransportState() === "open",
      closeSocket: () => {
        try {
          client.close();
        } catch {
          /* idempotent */
        }
      },
      pairManager: pairManagerRef.current,
      getRoomId: () => stateRef.current.local.roomId ?? null,
      getLocalStream: () => currentLocalStream(),
      getActiveScreenTrack: () => getActiveScreenTrack(),
      publishLocalStream,
      disposeScreenShare: () => controllerRef.current?.dispose(),
    });
  }
  // Refresh the manager dep on every render so a Leave triggered after
  // the manager appears (post-media-ready) sees a non-null reference.
  // The leave path closure reads `pairManager` from a ref captured at
  // create-time, so we re-create when the identity changes.
  useEffect(() => {
    leavePathRef.current = createMeshLeavePath({
      dispatch,
      send: (m) => sendRef.current(m),
      isSocketOpen: () => client.getTransportState() === "open",
      closeSocket: () => {
        try {
          client.close();
        } catch {
          /* idempotent */
        }
      },
      pairManager: pairManagerRef.current,
      getRoomId: () => stateRef.current.local.roomId ?? null,
      getLocalStream: () => currentLocalStream(),
      getActiveScreenTrack: () => getActiveScreenTrack(),
      publishLocalStream,
      disposeScreenShare: () => controllerRef.current?.dispose(),
    });
  }, [dispatch, client, pairManager]);

  const canLeave =
    fsm !== "idle" && fsm !== "leaving" && fsm !== "left";

  const onLeaveClick = () => {
    leavePathRef.current?.run();
  };

  const screenLabel = useMemo(() => {
    return screenShare === "active" ? "Stop sharing" : "Share screen";
  }, [screenShare]);

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
        <button
          type="button"
          onClick={onShareScreenClick}
          disabled={!canToggle}
          aria-pressed={screenShare === "active"}
          data-testid="mesh-controls-screen-share-button"
          data-state={screenShare}
        >
          {screenLabel}
        </button>
        <span
          className="mesh-controls__indicator"
          data-testid="mesh-controls-screen-share"
          data-state={screenShare}
          aria-label={`screen share ${screenShare}`}
        >
          screen share: {screenShare}
        </span>
        <button
          type="button"
          onClick={onLeaveClick}
          disabled={!canLeave}
          className="mesh-controls__leave"
          data-testid="mesh-controls-leave"
          data-state={fsm}
          aria-label="Leave mesh room"
        >
          Leave mesh
        </button>
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
