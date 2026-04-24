// LocalMediaProvider — owns the local MediaStream and drives the
// two-phase-join media lifecycle (Phase 6 T045 / T046 / T048).
//
// Ownership boundary:
// - The active MediaStream lives in a `useRef`, not in reducer state
//   (data-model §B.2). Consumers that need to re-render on acquire /
//   release subscribe to the small `streamVersion` number published
//   below — the ref stores the object identity, state just nudges
//   React.
// - The lifecycle effect watches `session.session`:
//     pending-media  → acquire + emit `media_ready` | `media_failed`
//     idle           → stop any live tracks (Path A, local-tracks
//                      portion per data-model §C.5).
//     media-error    → keep the stream released; Retry re-enters
//                      `joining` and a fresh `pending-media` will
//                      re-acquire.
// - Emission goes through the shared SignalingClient. The provider
//   does NOT dispatch JOIN_* or RETRY_* itself; those come from
//   JoinForm.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useDispatch, useRootState } from "../state";
import { makeEventLogEntry } from "../state/event-log";
import { useSignalingClient } from "../signaling/provider";
import { CONTRACT_VERSION } from "../types/contract";
import {
  acquireLocalMedia,
  stopTracks,
  type AcquireLocalMediaOptions,
  type MediaFailedReason,
} from "./media-acquisition";

export interface LocalMediaContextValue {
  // Stable getter for the live stream. Consumers attach this to a
  // `<video>` via an effect keyed on `streamVersion`.
  getStream: () => MediaStream | null;
  // Bumped whenever the stream reference changes (acquired or
  // released). Safe serialisable value for useEffect dep arrays.
  streamVersion: number;
  hasStream: boolean;
  // Stops all tracks on the current stream and clears the ref. Used
  // by the Leave button as the local-tracks portion of Path A
  // cleanup (data-model §C.5).
  release: () => void;
}

// Exported so tests may provide a custom value (see
// `tests/unit/media-controls.spec.ts`). Production code MUST go through
// `<LocalMediaProvider>` + `useLocalMedia()` — the export is a test
// seam, not a public API.
export const LocalMediaContext = createContext<LocalMediaContextValue | null>(
  null,
);

export interface LocalMediaProviderProps {
  children: ReactNode;
  // Test seam: inject a fake getUserMedia. Defaults to the browser's
  // navigator.mediaDevices.getUserMedia in production.
  acquireOptions?: AcquireLocalMediaOptions;
}

export function LocalMediaProvider({
  children,
  acquireOptions,
}: LocalMediaProviderProps) {
  const streamRef = useRef<MediaStream | null>(null);
  const [streamVersion, setStreamVersion] = useState(0);
  const { session } = useRootState();
  const dispatch = useDispatch();
  const client = useSignalingClient();

  // Stable getter — identity doesn't change between renders.
  const getStream = useCallback(() => streamRef.current, []);

  const setStream = useCallback((next: MediaStream | null) => {
    streamRef.current = next;
    setStreamVersion((v) => v + 1);
  }, []);

  const release = useCallback(() => {
    const current = streamRef.current;
    if (!current) return;
    stopTracks(current);
    setStream(null);
  }, [setStream]);

  // Lifecycle: drive acquire / emit based on session state. We do
  // NOT re-run on every session change — only on the *transitions*
  // this provider cares about (pending-media entry, leave to idle).
  const sessionState = session.session;
  const roomId = session.roomId;

  useEffect(() => {
    let cancelled = false;

    if (sessionState === "pending-media" && streamRef.current === null) {
      dispatch({
        type: "EVENT_LOG_APPEND",
        entry: makeEventLogEntry({
          type: "media_acquire_started",
          direction: "local",
          summary: "getUserMedia({audio:true, video:true}) requested",
        }),
      });
      void (async () => {
        const outcome = await acquireLocalMedia(acquireOptions);
        if (cancelled) {
          // Session left pending-media while we were awaiting the
          // prompt. If media arrived, release it immediately so the
          // device indicator clears.
          if (outcome.ok) stopTracks(outcome.stream);
          return;
        }
        if (outcome.ok) {
          setStream(outcome.stream);
          sendMediaReady(roomId);
          dispatch({ type: "MEDIA_READY_SENT" });
          dispatch({
            type: "EVENT_LOG_APPEND",
            entry: makeEventLogEntry({
              type: "media_ready_sent",
              direction: "local",
              summary: "media_ready sent (audio+video ready)",
              transport: "signaling",
            }),
          });
        } else {
          sendMediaFailed(roomId, outcome.reason, outcome.detail);
          dispatch({
            type: "EVENT_LOG_APPEND",
            entry: makeEventLogEntry({
              type: "media_failed_sent",
              direction: "local",
              summary: `media_failed sent (${outcome.reason})`,
              reason: outcome.reason,
              ...(outcome.detail !== undefined ? { code: outcome.detail } : {}),
              transport: "signaling",
            }),
          });
          // We do NOT transition to media-error locally — the server
          // owns that transition via participant_released.
        }
      })();
    }

    // Local-tracks cleanup on Path A: when the reducer returns to
    // idle (from a Leave click, failed connect, or similar) we must
    // stop any tracks that are still live. The same effect also
    // fires for the initial idle mount; `release()` no-ops when the
    // stream is already null.
    if (sessionState === "idle") {
      release();
    }

    return () => {
      cancelled = true;
    };
    // We deliberately omit `acquireOptions` — it is a test seam and
    // changing it mid-session is not a supported operation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionState, roomId, dispatch, release, setStream]);

  // Release on provider unmount (final safety net for hot-reload /
  // module disposal — React's StrictMode will also run this extra
  // time in dev, which is fine: release is idempotent).
  useEffect(() => {
    return () => {
      const s = streamRef.current;
      if (s) stopTracks(s);
      streamRef.current = null;
    };
  }, []);

  function sendMediaReady(currentRoomId: string | null) {
    if (!currentRoomId) return;
    try {
      client.send({
        v: CONTRACT_VERSION,
        type: "media_ready",
        roomId: currentRoomId,
        payload: {
          mediaCapabilities: { audio: true, video: true },
        },
      });
    } catch {
      // Best-effort: if the WS is gone, the server will reconcile via
      // its own timeout/disconnect handling.
    }
  }

  function sendMediaFailed(
    currentRoomId: string | null,
    reason: MediaFailedReason,
    detail: string | undefined,
  ) {
    if (!currentRoomId) return;
    try {
      client.send({
        v: CONTRACT_VERSION,
        type: "media_failed",
        roomId: currentRoomId,
        payload: {
          reason,
          ...(detail !== undefined ? { detail } : {}),
        },
      });
    } catch {
      // Same rationale as sendMediaReady.
    }
  }

  const value: LocalMediaContextValue = {
    getStream,
    streamVersion,
    hasStream: streamVersion > 0 && streamRef.current !== null,
    release,
  };

  return (
    <LocalMediaContext.Provider value={value}>
      {children}
    </LocalMediaContext.Provider>
  );
}

export function useLocalMedia(): LocalMediaContextValue {
  const ctx = useContext(LocalMediaContext);
  if (!ctx) {
    throw new Error(
      "useLocalMedia must be used inside <LocalMediaProvider>",
    );
  }
  return ctx;
}
