// ScreenShareProvider — Phase 12 (T080 / T082).
//
// Lifts the ScreenShareController out of `ScreenShareButton` so both
// the button AND the Path A / Path C cleanup orchestrator
// (`useCleanup` in `webrtc/cleanup.ts`) can call `stop("app")` on the
// same instance. Before Phase 12 the controller was created inside the
// button; closing the PC before the controller's final
// `replaceTrack(null)` landed would orphan the screen track. Phase 12
// must invoke `stop("app")` BEFORE `pc.close()` on the local-Leave and
// local-failure paths — this provider is the single seam that makes
// that ordering possible without reshaping the controller internals.
//
// The controller's hook surface (`getVideoSender`, `getCameraTrack`,
// `emitMediaState`, `log`) is unchanged from Phase 11; we just move
// the instantiation point up one level in the tree.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { useDispatch, useRootState } from "../state";
import { useSignalingClient } from "../signaling/provider";
import { CONTRACT_VERSION } from "../types/contract";
import { makeLog } from "./log";
import { readLocalMediaTriplet } from "@/shared/webrtc/media-acquisition";
import { useLocalMedia } from "./local-media-provider";
import { usePeerConnection } from "./peer-connection-provider";
import {
  createScreenShareController,
  type ScreenShareController,
  type ScreenShareHooks,
  type ScreenShareStartOutcome,
} from "./screen-share";

export interface ScreenShareContextValue {
  /** True while a screen-share track is wired to the video sender. */
  isActive(): boolean;
  /** Start screen share. See `ScreenShareController.start`. */
  start(): Promise<ScreenShareStartOutcome>;
  /** Stop screen share. See `ScreenShareController.stop`. */
  stop(source: "app" | "browser"): Promise<void>;
}

// Exported so tests may provide a custom value. Production code MUST
// go through `<ScreenShareProvider>` + `useScreenShare()`.
export const ScreenShareContext =
  createContext<ScreenShareContextValue | null>(null);

export interface ScreenShareProviderProps {
  children: ReactNode;
}

export function ScreenShareProvider({ children }: ScreenShareProviderProps) {
  const dispatch = useDispatch();
  const client = useSignalingClient();
  const { media, session } = useRootState();
  const { getStream } = useLocalMedia();
  const { getHandle } = usePeerConnection();

  // The controller is stateful (screen track, re-entry guard) and must
  // persist across renders. Store a single instance in a ref.
  const controllerRef = useRef<ScreenShareController | null>(null);

  // Read-only references used by the controller hooks. Captured in
  // refs so the controller — created once — always reads the latest
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
        // Fast path: current track kind identifies the video sender.
        const fast = handle.pc
          .getSenders()
          .find((s) => s.track?.kind === "video");
        if (fast) return fast;
        // Fallback: all senders null (post-stop-with-camera-off).
        // Walk transceivers, match on `receiver.track.kind === "video"`.
        const tx = handle.pc
          .getTransceivers()
          .find((t) => t.receiver.track?.kind === "video");
        return tx?.sender ?? null;
      },
      getCameraTrack: () => {
        const stream = getStreamRef.current();
        if (!stream) return null;
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
          (s.session === "connecting" || s.session === "connected") &&
          s.transport !== "error";
        if (!canEmit) return;
        try {
          clientRef.current.send({
            v: CONTRACT_VERSION,
            type: "media_state",
            roomId: s.roomId as string,
            payload: triplet,
          });
          makeLog((entry) =>
            dispatchRef.current({ type: "EVENT_LOG_APPEND", entry }),
          ).signaling({
            type: "media_state",
            direction: "local",
            summary: `media_state sent (mic=${triplet.microphone}, camera=${triplet.camera}, screen=${triplet.screenShare})`,
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

  // Release any live screen capture on unmount (HMR / StrictMode /
  // future route change). Mirrors the pattern in
  // `local-media-provider.tsx` and `peer-connection-provider.tsx`.
  useEffect(() => {
    return () => {
      void controller.stop("app").catch(() => {
        /* best-effort — the store / WS may already be torn down */
      });
    };
  }, [controller]);

  const isActive = useCallback(() => controller.isActive(), [controller]);
  const start = useCallback(() => controller.start(), [controller]);
  const stop = useCallback(
    (source: "app" | "browser") => controller.stop(source),
    [controller],
  );

  const value: ScreenShareContextValue = { isActive, start, stop };
  return (
    <ScreenShareContext.Provider value={value}>
      {children}
    </ScreenShareContext.Provider>
  );
}

export function useScreenShare(): ScreenShareContextValue {
  const ctx = useContext(ScreenShareContext);
  if (!ctx) {
    throw new Error(
      "useScreenShare must be used inside <ScreenShareProvider>",
    );
  }
  return ctx;
}
