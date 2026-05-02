// Screen-share controller (M10 / T075 + T076 + T078).
//
// Owns the local participant's screen-share lifecycle:
//   - START: getDisplayMedia({ video: true }) → for every active
//     outbound video sender, `sender.replaceTrack(screenTrack)` →
//     emit ONE `pair_media_state { screenShare: "active" }`.
//   - STOP: triggered by the in-app Stop button OR `screenTrack.onended`
//     (browser-native "Stop sharing"). Both paths run the SAME
//     cleanup/revert sequence — `replaceTrack(cameraTrack ?? null)`
//     across every active outbound video sender, then ONE
//     `pair_media_state { screenShare: "inactive" }`.
//
// Hard boundaries (M10):
//   - NEVER calls `pc.addTransceiver` — would add a 2nd outbound video
//     slot and break the sender-count invariant FR-070 / L16.
//   - NEVER calls `pc.addTrack` — same reason.
//   - NEVER calls `createOffer` / `setLocalDescription` — `replaceTrack`
//     does not require renegotiation.
//   - NEVER mutates other participants' state — screen share is purely
//     per-participant. There is no `currentSharer`, no
//     `screen_share_busy`, no auto-stop. Multiple participants MAY
//     share concurrently (FR-041).
//
// Idempotency:
//   - Repeated `start()` while active is a no-op.
//   - Repeated `stop()` while inactive is a no-op (no double-send of
//     `pair_media_state`, no double-replaceTrack).
//   - The `onended` handler is detached on stop so a self-induced stop
//     does not race with the browser's own end notification.

import type { Dispatch } from "react";
import type { MeshRootAction } from "../state";
import { makeMeshEventEntry } from "../state/eventLog";
import {
  MESH_CONTRACT_VERSION,
  type CameraState,
  type MeshClientMessage,
  type MicState,
  type PairMediaStatePayload,
} from "../signaling/schema";
import type { MeshPairContext } from "./pairContext";
import { findOutboundVideoSender } from "./senders";

export type ScreenShareStopSource = "app" | "browser";

export interface ScreenShareDeps {
  readonly dispatch: Dispatch<MeshRootAction>;
  readonly send: (message: MeshClientMessage) => void;
  readonly getRoomId: () => string | null;
  readonly getPairContexts: () => ReadonlyArray<MeshPairContext>;
  // Camera track used for the revert. May be `null` when the local
  // user's camera is off / unavailable; in that case `replaceTrack`
  // is called with `null`, producing the "camera-off placeholder"
  // behavior across remote tiles.
  readonly getCameraTrack: () => MediaStreamTrack | null;
  readonly getCameraState: () => CameraState;
  readonly getMicState: () => MicState;
  // Test-only injection — production reads `navigator.mediaDevices.getDisplayMedia`.
  readonly getDisplayMedia?: (
    constraints?: DisplayMediaStreamOptions,
  ) => Promise<MediaStream>;
}

export interface ScreenShareController {
  start(): Promise<void>;
  stop(source: ScreenShareStopSource): Promise<void>;
  isActive(): boolean;
  // Best-effort cleanup — call from React unmount paths.
  dispose(): void;
}

interface TrackedSender {
  readonly pairId: string;
  readonly remotePeerId: string;
  readonly sender: RTCRtpSender;
}

export function createScreenShareController(
  deps: ScreenShareDeps,
): ScreenShareController {
  let active = false;
  let starting = false;
  let stopping = false;
  let screenStream: MediaStream | null = null;
  let screenTrack: MediaStreamTrack | null = null;
  let trackedSenders: TrackedSender[] = [];

  function appendEvent(entry: Parameters<typeof makeMeshEventEntry>[0]): void {
    deps.dispatch({
      type: "MESH_EVENT_APPEND",
      entry: makeMeshEventEntry(entry),
    });
  }

  function pickGetDisplayMedia(): (
    constraints?: DisplayMediaStreamOptions,
  ) => Promise<MediaStream> {
    if (deps.getDisplayMedia) return deps.getDisplayMedia;
    const md = (
      globalThis as unknown as {
        navigator?: {
          mediaDevices?: {
            getDisplayMedia?: (
              constraints?: DisplayMediaStreamOptions,
            ) => Promise<MediaStream>;
          };
        };
      }
    ).navigator?.mediaDevices;
    if (!md || typeof md.getDisplayMedia !== "function") {
      return () =>
        Promise.reject(
          new Error("getDisplayMedia is not available in this environment"),
        );
    }
    return md.getDisplayMedia.bind(md);
  }

  function sendMediaState(screenShareNext: "active" | "inactive"): void {
    const roomId = deps.getRoomId();
    if (!roomId) {
      appendEvent({
        scope: "local",
        type: "signaling_error",
        summary: `failed to send pair_media_state: missing roomId (screenShare=${screenShareNext})`,
      });
      return;
    }
    const payload: PairMediaStatePayload = {
      microphone: deps.getMicState(),
      camera: deps.getCameraState(),
      screenShare: screenShareNext,
    };
    try {
      deps.send({
        v: MESH_CONTRACT_VERSION,
        type: "pair_media_state",
        roomId,
        payload,
      });
    } catch (err) {
      appendEvent({
        scope: "local",
        type: "signaling_error",
        summary: `failed to send pair_media_state: ${
          (err as Error).message ?? "unknown"
        }`,
      });
      return;
    }
    appendEvent({
      scope: "room",
      type: "mesh_media_state_sent",
      summary:
        "pair_media_state sent (signaling metadata path; server fan-out, not media path)",
      detail: {
        transport: "signaling",
        path: "metadata",
      },
    });
  }

  async function start(): Promise<void> {
    if (active || starting || stopping) return;
    starting = true;
    let stream: MediaStream;
    try {
      stream = await pickGetDisplayMedia()({ video: true });
    } catch (err) {
      // Picker cancellation (NotAllowedError / AbortError) is a normal
      // user action — log a human-readable entry but DO NOT change
      // local state and DO NOT send `pair_media_state`.
      appendEvent({
        scope: "local",
        type: "mesh_media_local_toggled",
        summary: "screen share cancelled (user cancelled picker)",
        detail: {
          kind: "screen-share",
          next: "cancelled",
          reason: (err as Error).message ?? "user-cancelled",
        },
      });
      starting = false;
      return;
    }
    const videoTracks = stream.getVideoTracks();
    if (videoTracks.length === 0) {
      // Some browsers resolve with an empty stream when the user
      // dismisses the picker. Treat as cancellation.
      try {
        for (const t of stream.getTracks()) t.stop();
      } catch {
        /* ignore */
      }
      appendEvent({
        scope: "local",
        type: "mesh_media_local_toggled",
        summary: "screen share cancelled (no video tracks selected)",
        detail: { kind: "screen-share", next: "cancelled" },
      });
      starting = false;
      return;
    }
    const newTrack = videoTracks[0];
    screenStream = stream;
    screenTrack = newTrack;

    // Replace the outgoing video track on every active outbound video
    // sender. We snapshot the list first so a context appearing mid-
    // operation does not double-fire; new contexts allocated AFTER
    // start follow the existing pairManager attach path (camera track).
    const contexts = deps.getPairContexts();
    trackedSenders = [];
    for (const ctx of contexts) {
      if (ctx.state === "closed") continue;
      const sender = findOutboundVideoSender(ctx);
      if (!sender) continue;
      trackedSenders.push({
        pairId: ctx.pairId,
        remotePeerId: ctx.remotePeerId,
        sender,
      });
      try {
        await sender.replaceTrack(newTrack);
        appendEvent({
          scope: "pair",
          type: "mesh_media_local_toggled",
          summary: `local track replaced (camera→screen) (pair ${ctx.pairId})`,
          peerId: ctx.remotePeerId,
          pairId: ctx.pairId,
          detail: {
            kind: "screen-share",
            transition: "camera-to-screen",
          },
        });
      } catch (err) {
        appendEvent({
          scope: "pair",
          type: "error_occurred",
          summary: `replaceTrack(screenTrack) failed (pair ${ctx.pairId})`,
          peerId: ctx.remotePeerId,
          pairId: ctx.pairId,
          detail: {
            kind: "screen-share-replacetrack-failed",
            transition: "camera-to-screen",
            error: (err as Error).message ?? "unknown",
          },
        });
      }
    }

    // Wire browser-native stop. The user can hit the OS-level
    // "Stop sharing" bar — that fires `track.onended`. Both paths
    // share the same cleanup via `stop()`.
    newTrack.onended = () => {
      void stop("browser");
    };

    active = true;
    starting = false;

    deps.dispatch({ type: "MESH_LOCAL_MEDIA_SCREEN_SHARE_STARTED" });
    appendEvent({
      scope: "local",
      type: "mesh_media_local_toggled",
      summary: "screen share started",
      detail: { kind: "screen-share", next: "active" },
    });

    sendMediaState("active");
  }

  async function stop(source: ScreenShareStopSource): Promise<void> {
    if (!active || stopping) return;
    stopping = true;

    // Compute the replacement track BEFORE we tear down the screen
    // track so the camera track lookup mirrors the live local-media
    // state. When the camera is off (M9 toggle, `track.enabled = false`)
    // we still revert to the camera *track* so subsequent M9 toggles
    // can flip `enabled` again. When the camera track is unavailable
    // entirely (e.g. permission revoked), we revert to `null` —
    // remote tiles render the camera-off placeholder.
    const cameraOn = deps.getCameraState() === "on";
    const cameraTrack = cameraOn ? deps.getCameraTrack() : deps.getCameraTrack();
    const replacementTrack = cameraTrack;
    const transition: "screen-to-camera" | "screen-to-camera-off" = cameraTrack
      ? "screen-to-camera"
      : "screen-to-camera-off";

    // Detach onended BEFORE stopping the track so a self-induced stop
    // doesn't loop back into stop("browser") via the handler.
    if (screenTrack) {
      screenTrack.onended = null;
      try {
        if (screenTrack.readyState !== "ended") {
          screenTrack.stop();
        }
      } catch {
        /* ignore — already ended */
      }
    }
    if (screenStream) {
      try {
        for (const t of screenStream.getTracks()) {
          if (t.readyState !== "ended") {
            try {
              t.stop();
            } catch {
              /* ignore */
            }
          }
        }
      } catch {
        /* ignore */
      }
    }

    for (const tracked of trackedSenders) {
      try {
        await tracked.sender.replaceTrack(replacementTrack);
        appendEvent({
          scope: "pair",
          type: "mesh_media_local_toggled",
          summary: cameraTrack
            ? `local track replaced (screen→camera) (pair ${tracked.pairId})`
            : `local track replaced (screen→camera-off) (pair ${tracked.pairId})`,
          peerId: tracked.remotePeerId,
          pairId: tracked.pairId,
          detail: {
            kind: "screen-share",
            transition,
            source,
          },
        });
      } catch (err) {
        appendEvent({
          scope: "pair",
          type: "error_occurred",
          summary: `replaceTrack(${
            cameraTrack ? "cameraTrack" : "null"
          }) failed (pair ${tracked.pairId})`,
          peerId: tracked.remotePeerId,
          pairId: tracked.pairId,
          detail: {
            kind: "screen-share-replacetrack-failed",
            transition,
            error: (err as Error).message ?? "unknown",
          },
        });
      }
    }

    trackedSenders = [];
    screenStream = null;
    screenTrack = null;
    active = false;
    stopping = false;

    deps.dispatch({ type: "MESH_LOCAL_MEDIA_SCREEN_SHARE_STOPPED" });
    appendEvent({
      scope: "local",
      type: "mesh_media_local_toggled",
      summary: `screen share stopped (source=${source})`,
      detail: { kind: "screen-share", next: "inactive", source },
    });

    sendMediaState("inactive");
  }

  function isActive(): boolean {
    return active;
  }

  function dispose(): void {
    if (screenTrack) {
      try {
        screenTrack.onended = null;
        if (screenTrack.readyState !== "ended") screenTrack.stop();
      } catch {
        /* ignore */
      }
    }
    if (screenStream) {
      try {
        for (const t of screenStream.getTracks()) {
          if (t.readyState !== "ended") {
            try {
              t.stop();
            } catch {
              /* ignore */
            }
          }
        }
      } catch {
        /* ignore */
      }
    }
    trackedSenders = [];
    screenStream = null;
    screenTrack = null;
    active = false;
    starting = false;
    stopping = false;
  }

  return { start, stop, isActive, dispose };
}
