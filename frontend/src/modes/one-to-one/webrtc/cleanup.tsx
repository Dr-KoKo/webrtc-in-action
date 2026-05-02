// Cleanup orchestrator — Phase 12 (§C.5 Path A / Path B / Path C +
// §B.1.1 signaling-disconnect branching).
//
// This file owns the three cleanup step sequences. Getting the steps
// in the wrong order — specifically, stopping local tracks in the
// remote-peer-left path — is the bug class Phase 12 exists to
// prevent. The orderings are reproduced below from data-model §C.5:
//
//   Path A (local Leave):
//     1. stop local tracks
//     2. stop screen share (if active)      ← BEFORE pc.close() so the
//     3. close DataChannel                    final replaceTrack(null)
//     4. close RTCPeerConnection              lands on the live sender
//     5. send `leave_room` if WS still open
//     6. drop PC / IceBuffer refs (inside teardownPeerConnection)
//     7. close WS
//     8. reducer SESSION_RESET (→ idle)
//     9. event log `cleanup completed`, code: "local_leave"
//
//   Path B (remote peer_left):
//     1. close DataChannel
//     2. close RTCPeerConnection + clear IceBuffer
//     3. clear RemoteMediaState
//     — local tracks STAY LIVE; WS stays open —
//     4. reducer PEER_LEFT (connecting|connected → waiting-for-peer)
//     5. event log `cleanup completed`, code: "remote_peer_left"
//
//   Path C (ICE / fatal PC failure):
//     Reached via `onConnectionStateChange === "failed"` inside
//     PeerConnectionProvider, which runs step 1–3 of Path B there
//     and dispatches CONNECTION_FAILED. The Leave / Rejoin buttons in
//     FailurePanel then call leaveSession() or rejoin() here —
//     rejoin() is "Path A followed by a fresh Join" (no new contract
//     message; see §C.5 Path C step 7).
//
// Signaling-disconnect is its own axis (not a cleanup path):
//   - transport → error while session ∈ {joining, pending-media,
//     waiting-for-peer, connecting} → dispatch CONNECTION_FAILED
//     (no stable P2P yet).
//   - transport → error while session == connected → dispatch
//     TRANSPORT_CHANGED(error) alone; media keeps flowing P2P;
//     leave_room / media_state / screen-share renegotiation become
//     unavailable until transport recovers (gated at the send sites).

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
import {
  useFrameSubscription,
  useSignalingClient,
} from "../signaling/provider";
import { useLocalMedia } from "./local-media-provider";
import { usePeerConnection } from "./peer-connection-provider";
import { useScreenShare } from "./screen-share-provider";
import { signalingMessageSchema } from "../protocol/schema";
import { CONTRACT_VERSION } from "../types/contract";
import { makeLog } from "./log";
import type { SessionState } from "../state/session";

export interface CleanupContextValue {
  /**
   * Path A — user clicked Leave (or rejoin wants a clean slate).
   * Runs the full §C.5 Path A step sequence. Safe to call from any
   * session state; idempotent.
   */
  leaveSession(): Promise<void>;
  /**
   * Path C recovery — Leave from failed, then fresh Join on the same
   * room. Implemented as leaveSession() followed by the caller
   * opening a new WS + join_room; we expose just the Path A half
   * here so the JoinForm retains ownership of the connect/send flow.
   * Returns the room id that was active (caller uses it for the new
   * Join), or null if nothing to rejoin.
   */
  rejoin(): Promise<string | null>;
}

// Exported so tests may provide a custom value. Production code MUST
// go through `<CleanupProvider>` + `useCleanup()`.
export const CleanupContext = createContext<CleanupContextValue | null>(null);

export interface CleanupProviderProps {
  children: ReactNode;
}

// Session states from which leave_room may still be sent gracefully
// (contract §3.14). When transport is in "error" (signaling
// disconnect, §B.1.1), we skip the send — there's no WS to write to.
const CAN_SEND_LEAVE_ROOM: ReadonlySet<SessionState> = new Set([
  "joining",
  "pending-media",
  "waiting-for-peer",
  "media-error",
  "connecting",
  "connected",
  "leaving",
]);

export function CleanupProvider({ children }: CleanupProviderProps) {
  const dispatch = useDispatch();
  const state = useRootState();
  const client = useSignalingClient();
  const localMedia = useLocalMedia();
  const peerConnection = usePeerConnection();
  const screenShare = useScreenShare();

  // Mirror everything the async handlers need into refs so the
  // orchestrator reads fresh values without being recreated on every
  // render. Same pattern as PeerConnectionProvider / ScreenShareProvider.
  const sessionRef = useRef(state.session);
  sessionRef.current = state.session;
  const clientRef = useRef(client);
  clientRef.current = client;
  const localMediaRef = useRef(localMedia);
  localMediaRef.current = localMedia;
  const peerConnectionRef = useRef(peerConnection);
  peerConnectionRef.current = peerConnection;
  const screenShareRef = useRef(screenShare);
  screenShareRef.current = screenShare;
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;
  // Stable log helper — closes over dispatchRef so it always writes
  // through the latest dispatch fn without being recreated.
  const logRef = useRef(
    makeLog((entry) =>
      dispatchRef.current({ type: "EVENT_LOG_APPEND", entry }),
    ),
  );

  const leaveSession = useCallback(async (): Promise<void> => {
    const s = sessionRef.current;
    if (s.session === "idle") {
      // Defensive no-op: nothing to tear down.
      return;
    }
    // §C.5 Path A step order is the CONTRACT. Violating it is the
    // "local camera off when remote hangs up" bug class.
    //
    // 1. Stop local tracks.
    localMediaRef.current.release();
    // 2. Stop screen share if active (BEFORE pc.close()). The
    //    controller's final replaceTrack(null) must land on the live
    //    sender; Phase 11's stop path is idempotent.
    try {
      await screenShareRef.current.stop("app");
    } catch {
      // Best-effort; the controller tolerates redundant stops.
    }
    // 3 + 4. Close DC + PC + clear IceBuffer + clear remote tracks.
    peerConnectionRef.current.teardownPeerConnection("local_leave");
    // 5. Send `leave_room` if WS still alive + session state allows it.
    const canSend =
      s.roomId !== null &&
      s.transport === "connected" &&
      CAN_SEND_LEAVE_ROOM.has(s.session);
    if (canSend && s.roomId) {
      try {
        clientRef.current.send({
          v: CONTRACT_VERSION,
          type: "leave_room",
          roomId: s.roomId,
          payload: {},
        });
        logRef.current.signaling({
          type: "leave_requested",
          direction: "local",
          summary: "leave_room sent",
        });
      } catch {
        // Best-effort; WS might have closed between state read and
        // send. The server's disconnect classifier will clean up.
      }
    }
    // 6 was absorbed into teardownPeerConnection.
    // 7. Close WS.
    try {
      clientRef.current.close();
    } catch {
      // idempotent
    }
    // 8. Reset reducer → idle. LEAVE_REQUESTED is accepted from every
    //    non-idle state (Phase 12 widened it).
    dispatchRef.current({ type: "LEAVE_REQUESTED" });
    dispatchRef.current({ type: "REMOTE_MEDIA_STATE_CLEARED" });
    // 9. Emit the cleanup-completed narration. code: "local_leave" is
    //    the only enum value here — NEVER raw error messages, WS
    //    close codes, or user-derived strings (NFR-006).
    logRef.current.system({
      type: "cleanup_completed",
      direction: "system",
      summary: "cleanup completed (path=local_leave)",
      code: "local_leave",
    });
  }, []);

  const rejoin = useCallback(async (): Promise<string | null> => {
    const previousRoomId = sessionRef.current.roomId;
    await leaveSession();
    return previousRoomId;
  }, [leaveSession]);

  // ----- Inbound `peer_left` → Path B orchestrator -----
  //
  // We subscribe to raw WS frames (same pattern as
  // PeerConnectionProvider) and parse via the shared Zod schema. The
  // dispatcher's fallback branch would otherwise log a generic
  // "future-phase handler" entry; we keep the dispatcher's fallback
  // intact and let this handler drive the actual cleanup — the
  // dispatcher's `peer_left` row becomes a narration complement, not
  // a duplicate.
  useFrameSubscription((raw) => {
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        return;
      }
      const parsed = signalingMessageSchema.safeParse(json);
      if (!parsed.success) return;
      if (parsed.data.type !== "peer_left") return;
      // Invariant guard (T083): Path B must NEVER run against a
      // non-existent PC. pending-media releases are routed through
      // peer_presence_changed(presence="released") alone — the
      // server MUST NOT emit peer_left in that case (§3.12 +
      // server §C.6). If this fires anyway, log and refuse to run
      // Path B; calling teardownPeerConnection with no handle is
      // itself idempotent, but the reducer transition would
      // incorrectly collapse our session state.
      if (peerConnectionRef.current.getHandle() === null) {
        logRef.current.signaling({
          type: "error_occurred",
          direction: "system",
          summary: "peer_left received but no active PC; ignoring",
          code: "unexpected_peer_left",
        });
        return;
      }
      // §C.5 Path B:
      // 1 + 2. Close DC + PC + clear IceBuffer + detach remote tracks.
      peerConnectionRef.current.teardownPeerConnection("remote_peer_left");
      // 3. Clear RemoteMediaState.
      dispatchRef.current({ type: "REMOTE_MEDIA_STATE_CLEARED" });
      // 4. Transition `connecting | connected → waiting-for-peer`.
      //    Local tracks remain live (LocalMediaProvider untouched).
      //    WS stays open.
      dispatchRef.current({ type: "PEER_LEFT" });
      // 5. Event-log narration.
      logRef.current.system({
        type: "cleanup_completed",
        direction: "system",
        summary: "cleanup completed (path=remote_peer_left)",
        code: "remote_peer_left",
      });
  }, []);

  // ----- Transport-disconnect branching (§B.1.1) -----
  //
  // Separate axis from the three cleanup paths. We subscribe to the
  // client's transport-state observable; on transition to "error":
  //   - pre-connected (joining | pending-media | waiting-for-peer |
  //     connecting) → dispatch CONNECTION_FAILED (session → failed).
  //   - connected → no session transition; the transport slice
  //     already carries `error`, and leave_room / media_state /
  //     screen-share renegotiation are gated at their send sites.
  //     Emit a single warning log entry; media keeps flowing P2P.
  useEffect(() => {
    const unsubscribe = clientRef.current.onTransportChange((next) => {
      if (next !== "error") return;
      const current = sessionRef.current.session;
      if (
        current === "joining" ||
        current === "pending-media" ||
        current === "waiting-for-peer" ||
        current === "connecting"
      ) {
        dispatchRef.current({ type: "CONNECTION_FAILED" });
        dispatchRef.current({ type: "REMOTE_MEDIA_STATE_CLEARED" });
        peerConnectionRef.current.teardownPeerConnection("local_failure");
        logRef.current.signaling({
          type: "error_occurred",
          direction: "system",
          summary: "signaling transport dropped before P2P — session failed",
          code: "transport_error_pre_connected",
        });
        logRef.current.system({
          type: "cleanup_completed",
          direction: "system",
          summary: "cleanup completed (path=local_failure)",
          code: "local_failure",
        });
      } else if (current === "connected") {
        // Teachable moment: media stays P2P; only the warning log
        // line surfaces. SessionState stays `connected`; the
        // transport slice's `error` drives the UI warning.
        logRef.current.signaling({
          type: "error_occurred",
          direction: "system",
          summary:
            "signaling transport dropped — media continues P2P (§B.1.1)",
          code: "transport_error_during_connected",
        });
      }
    });
    return unsubscribe;
  }, []);

  const value = useMemo<CleanupContextValue>(
    () => ({ leaveSession, rejoin }),
    [leaveSession, rejoin],
  );

  return (
    <CleanupContext.Provider value={value}>{children}</CleanupContext.Provider>
  );
}

export function useCleanup(): CleanupContextValue {
  const ctx = useContext(CleanupContext);
  if (!ctx) {
    throw new Error("useCleanup must be used inside <CleanupProvider>");
  }
  return ctx;
}
