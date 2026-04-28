// Mesh local-media acquisition (T039 + T044). Drives the mesh local
// FSM through the two-phase join readiness handshake:
//
//   joined ──MEDIA_ACQUIRE_STARTED──▶ acquiring-media
//          getUserMedia({audio:true, video:true})
//             ├ success ──▶ MEDIA_READY + send `media_ready` to /ws/mesh
//             └ failure ──▶ MEDIA_FAILED + send `media_failed`
//
// On retry: the user clicks the banner Retry which dispatches
// MESH_RETRY_REQUESTED; the controller re-acquires getUserMedia
// without a full page reload (data-model §B.1, contract §3.6 / §3.7).
//
// The hard boundary for this batch (M5):
//   - getUserMedia is invoked ONLY after `join_accepted`.
//   - No `RTCPeerConnection` is created here. M6+ owns PC creation.
//
// `acquireLocalMedia` lives in `shared/webrtc/` — it's a pure
// helper both modes import via the `@/shared/...` alias. Avoids two
// drifting implementations of the DOMException → contract-enum
// classifier (governed by the shared `MediaFailedReason` set).

import { useEffect, useRef } from "react";
import { acquireLocalMedia } from "@/shared/webrtc/media-acquisition";
import { MESH_CONTRACT_VERSION, mediaFailedPayloadSchema } from "../signaling/schema";
import { useMeshDispatch, useMeshState } from "../state";
import { makeMeshEventEntry } from "../state/eventLog";
import { useMeshSignalingClient } from "../signaling/provider";
import type { z } from "zod";

export type MeshMediaFailedReason =
  z.infer<typeof mediaFailedPayloadSchema>["reason"];

// Media controller — auto-runs getUserMedia when the local FSM enters
// `joined` for the first time, or on retry from `media-error`. Holds
// the acquired MediaStream in a ref so M6+ can reuse the same tracks
// across every pair (data-model §B.3, sender count invariant 2 × N−1).
//
// Note on the `joined`-trigger: the FSM transitions
// `joined → acquiring-media → media-ready` while this effect is mid-
// flight, so we cannot key the effect on `local.fsm` alone (that would
// re-run / cancel as the FSM walks). Instead the effect tracks a
// per-admission "have we attempted acquisition?" latch keyed on
// `peerId`. The latch resets on `idle | released | left` so the
// MediaErrorBanner's Retry (which routes media-error → joined) can
// re-trigger acquisition on the same admission.
export function MeshMediaController() {
  const { local } = useMeshState();
  const dispatch = useMeshDispatch();
  const client = useMeshSignalingClient();
  const streamRef = useRef<MediaStream | null>(null);
  const acquireGenRef = useRef(0);
  const lastTriggerRef = useRef<string | null>(null);

  useEffect(() => {
    if (local.fsm !== "joined") return;
    // Build a per-attempt key so a Retry from media-error → joined
    // re-triggers acquisition exactly once per re-entry into `joined`.
    const triggerKey = `${local.peerId ?? "anon"}#${acquireGenRef.current}`;
    if (lastTriggerRef.current === triggerKey) return;
    lastTriggerRef.current = triggerKey;

    // F-3: defensive `roomId` guard. Reachable only via reducer bug —
    // the FSM only enters `joined` after MESH_JOIN_REQUESTED stored a
    // roomId. Walk the FSM joined → acquiring-media → media-error so
    // the user sees the banner and lastTriggerRef state is consistent.
    // Dispatching MESH_MEDIA_FAILED directly from `joined` would be
    // silently dropped by the reducer guard (must be in
    // acquiring-media to fail), causing a deadlock with no banner.
    if (!local.roomId) {
      dispatch({ type: "MESH_MEDIA_ACQUIRE_STARTED" });
      dispatch({ type: "MESH_MEDIA_FAILED", detail: "missing roomId" });
      dispatch({
        type: "MESH_EVENT_APPEND",
        entry: makeMeshEventEntry({
          scope: "local",
          type: "media_failed_sent",
          summary: "media-acquire aborted: roomId absent at effect entry",
        }),
      });
      return;
    }
    const roomId = local.roomId;

    const myGen = acquireGenRef.current;
    void (async () => {
      dispatch({ type: "MESH_MEDIA_ACQUIRE_STARTED" });
      dispatch({
        type: "MESH_EVENT_APPEND",
        entry: makeMeshEventEntry({
          scope: "local",
          type: "media_acquire_started",
          summary: "getUserMedia({audio:true, video:true}) requested",
        }),
      });
      const outcome = await acquireLocalMedia();
      // If a reset / new admission happened since we started, drop.
      if (myGen !== acquireGenRef.current) return;
      if (outcome.ok) {
        // Publish the stream FIRST so LocalPreview renders the live
        // self-tile immediately. Stream publication is local-only;
        // the FSM transition (MESH_MEDIA_READY) is gated on the wire
        // send — see F-2 below.
        streamRef.current = outcome.stream;
        publishLocalStream(outcome.stream);
        try {
          client.send({
            v: MESH_CONTRACT_VERSION,
            type: "media_ready",
            roomId,
            payload: { mediaCapabilities: { audio: true, video: true } },
          });
        } catch (err) {
          // F-2: send failed → server doesn't know we're media-ready.
          // Stop the just-acquired tracks (read from outcome.stream,
          // not streamRef.current — explicit), clear the published
          // stream, and walk the FSM acquiring-media → media-error
          // so the banner appears. The user can Retry; M11 covers
          // signaling-loss UX (EC-012).
          for (const t of outcome.stream.getTracks()) {
            try { t.stop(); } catch { /* already ended */ }
          }
          streamRef.current = null;
          publishLocalStream(null);
          dispatch({ type: "MESH_MEDIA_FAILED", detail: "ws send failed" });
          dispatch({
            type: "MESH_EVENT_APPEND",
            entry: makeMeshEventEntry({
              scope: "local",
              type: "signaling_error",
              summary: `failed to send media_ready: ${(err as Error).message ?? "unknown"}`,
            }),
          });
          return;
        }
        // Send succeeded → commit FSM transition. media_ready_sent log
        // entry fires AFTER send (gated on success), not before.
        dispatch({ type: "MESH_MEDIA_READY" });
        dispatch({
          type: "MESH_EVENT_APPEND",
          entry: makeMeshEventEntry({
            scope: "local",
            type: "media_ready_sent",
            summary: "media acquired; media_ready sent",
          }),
        });
      } else {
        const detail = outcome.detail ?? outcome.reason;
        try {
          client.send({
            v: MESH_CONTRACT_VERSION,
            type: "media_failed",
            roomId,
            payload: {
              reason: outcome.reason,
              ...(outcome.detail ? { detail: outcome.detail } : {}),
            },
          });
        } catch (err) {
          // F-2 failure-path mirror: send failed but the local user
          // already failed acquisition — FSM still must reflect that.
          // Server will catch up via Pong-timeout if we never told it.
          dispatch({
            type: "MESH_MEDIA_FAILED",
            ...(detail !== undefined ? { detail } : {}),
          });
          dispatch({
            type: "MESH_EVENT_APPEND",
            entry: makeMeshEventEntry({
              scope: "local",
              type: "signaling_error",
              summary: `failed to send media_failed: ${(err as Error).message ?? "unknown"}`,
            }),
          });
          return;
        }
        // Send succeeded → commit FSM transition + log.
        dispatch({
          type: "MESH_MEDIA_FAILED",
          ...(detail !== undefined ? { detail } : {}),
        });
        dispatch({
          type: "MESH_EVENT_APPEND",
          entry: makeMeshEventEntry({
            scope: "local",
            type: "media_failed_sent",
            summary: `media acquisition failed (${outcome.reason}); media_failed sent`,
            detail: { reason: outcome.reason, detail: outcome.detail },
          }),
        });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [local.fsm, local.peerId]);

  // Reset the latch on any state that means "we left the room" or
  // "the user explicitly retried" so the next entry into `joined`
  // triggers a fresh acquisition.
  useEffect(() => {
    if (
      local.fsm === "idle" ||
      local.fsm === "left" ||
      local.fsm === "released" ||
      local.fsm === "media-error"
    ) {
      acquireGenRef.current += 1;
      lastTriggerRef.current = null;
    }
  }, [local.fsm]);

  // Drop the stream when the local participant resets / leaves. M11
  // owns the full Path A teardown; M5 handles the simple stop.
  useEffect(() => {
    if (
      local.fsm === "idle" ||
      local.fsm === "left" ||
      local.fsm === "released"
    ) {
      const s = streamRef.current;
      if (s) {
        for (const t of s.getTracks()) {
          try {
            t.stop();
          } catch {
            // already ended
          }
        }
      }
      streamRef.current = null;
      publishLocalStream(null);
    }
  }, [local.fsm]);

  // Unmount-only cleanup. Runs exactly once on unmount regardless of
  // fsm value at the time. Targets the browser-back-button-while-
  // in-room race that no Path A/B/C scenario covers (data-model §C.3
  // Path A is graceful Leave; B is remote peer_left; this is neither).
  //
  // May double-fire after a graceful Leave (the FSM-driven effect
  // above already nulled the stream); idempotent by design —
  // track.stop() on stopped tracks is a no-op, double
  // publishLocalStream(null) is fine.
  useEffect(() => {
    return () => {
      const s = streamRef.current;
      if (s) {
        for (const t of s.getTracks()) {
          try {
            t.stop();
          } catch {
            // already ended
          }
        }
      }
      streamRef.current = null;
      publishLocalStream(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}

// Module-scoped publication of the acquired stream so `LocalPreview`
// can render it without prop-drilling. Replaced in M6+ when the pair
// manager owns the senders directly.
type StreamListener = (stream: MediaStream | null) => void;
const streamListeners = new Set<StreamListener>();
let currentLocalStream: MediaStream | null = null;

function publishLocalStream(s: MediaStream | null) {
  currentLocalStream = s;
  for (const l of streamListeners) l(s);
}

export function subscribeLocalStream(listener: StreamListener): () => void {
  streamListeners.add(listener);
  // Synchronously deliver current value.
  listener(currentLocalStream);
  return () => streamListeners.delete(listener);
}
