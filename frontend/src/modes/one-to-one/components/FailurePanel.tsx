// FailurePanel — Phase 12 (T082).
//
// Rendered by AppShell when `session.session === "failed"`. Shows two
// buttons:
//   - Leave  → runs Path A via `useCleanup().leaveSession()` →
//              reducer → `idle`.
//   - Rejoin → "convenience alias for Leave + fresh Join" (data-model
//              §C.5 Path C step 7). Runs leaveSession() and then
//              re-enters the normal Join flow on the previous room id.
//              No new signaling-contract message is introduced — the
//              client opens a fresh WS and sends `join_room` exactly
//              like a first-time Join.
//
// Local MediaStreamTracks are NOT stopped on entry to `failed` (the
// PeerConnectionProvider's Path-C-on-connectionstatechange only
// tears down the PC / DC / remote state). They are released here when
// either button fires, because both routes execute Path A in full —
// that's how FR-024 ("Leaving MUST stop all local media tracks") stays
// honored on every terminal transition without introducing a new
// "release slot" contract message.

import { useCallback, useState, type FormEvent } from "react";
import { CONTRACT_VERSION, ROOM_ID_REGEX } from "../types/contract";
import { useDispatch, useRootState } from "../state";
import { useSignalingClient } from "../signaling/provider";
import { useCleanup } from "../webrtc/cleanup";
import { makeEventLogEntry } from "../state/event-log";

// Same-origin signaling URL — mirrors JoinForm.resolveSignalingUrl so
// rejoin-after-failure uses identical transport setup to the initial
// connect. See JoinForm.tsx for the override semantics.
function resolveSignalingUrl(): string {
  const override = import.meta.env.VITE_SIGNALING_URL as string | undefined;
  if (override && override.length > 0) return override;
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws`;
}

export function FailurePanel() {
  const { session } = useRootState();
  const dispatch = useDispatch();
  const client = useSignalingClient();
  const { leaveSession, rejoin } = useCleanup();
  const [busy, setBusy] = useState(false);

  const visible = session.session === "failed";

  const onLeave = useCallback(
    async (ev: FormEvent<HTMLButtonElement>) => {
      ev.preventDefault();
      if (busy) return;
      setBusy(true);
      try {
        await leaveSession();
      } finally {
        setBusy(false);
      }
    },
    [busy, leaveSession],
  );

  const onRejoin = useCallback(
    async (ev: FormEvent<HTMLButtonElement>) => {
      ev.preventDefault();
      if (busy) return;
      setBusy(true);
      try {
        const previousRoomId = await rejoin();
        if (!previousRoomId) return;
        // Validate against the contract regex — defensive even though
        // the room id came from our own session state (§3.3).
        if (!ROOM_ID_REGEX.test(previousRoomId)) return;
        dispatch({ type: "JOIN_REQUESTED", roomId: previousRoomId });
        try {
          await client.connect(resolveSignalingUrl());
        } catch (err) {
          dispatch({
            type: "EVENT_LOG_APPEND",
            entry: makeEventLogEntry({
              type: "error_occurred",
              direction: "local",
              summary: `ws connect failed: ${(err as Error).message ?? "unknown"}`,
              code: "transport_error",
              transport: "signaling",
            }),
          });
          dispatch({ type: "LEAVE_REQUESTED" });
          return;
        }
        const requestId = crypto.randomUUID();
        try {
          client.send({
            v: CONTRACT_VERSION,
            type: "join_room",
            roomId: previousRoomId,
            requestId,
            payload: {},
          });
          dispatch({
            type: "EVENT_LOG_APPEND",
            entry: makeEventLogEntry({
              type: "join_room_sent",
              direction: "local",
              summary: `join_room sent (roomId=${previousRoomId})`,
              transport: "signaling",
            }),
          });
        } catch (err) {
          dispatch({
            type: "EVENT_LOG_APPEND",
            entry: makeEventLogEntry({
              type: "error_occurred",
              direction: "local",
              summary: `join_room send failed: ${(err as Error).message ?? "unknown"}`,
              code: "transport_error",
              transport: "signaling",
            }),
          });
          dispatch({ type: "LEAVE_REQUESTED" });
        }
      } finally {
        setBusy(false);
      }
    },
    [busy, client, dispatch, rejoin],
  );

  if (!visible) return null;

  return (
    <section
      aria-labelledby="failure-panel-heading"
      className="failure-panel"
      role="alert"
    >
      <h2 id="failure-panel-heading">Connection failed</h2>
      <p>
        The peer connection ended unexpectedly. Your camera and
        microphone are still active — choose to leave entirely or
        rejoin the same room with a fresh connection.
      </p>
      <div className="failure-panel__actions">
        <button
          type="button"
          data-testid="failure-panel-leave"
          disabled={busy}
          onClick={onLeave}
        >
          Leave
        </button>
        <button
          type="button"
          data-testid="failure-panel-rejoin"
          disabled={busy}
          onClick={onRejoin}
        >
          Rejoin
        </button>
      </div>
    </section>
  );
}
