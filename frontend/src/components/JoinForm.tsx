// JoinForm — room-ID entry + Join / Leave affordance.
//
// Phase 5 behavior:
// - Client-side validates room ID against the contract regex
//   ^[A-Za-z0-9._-]{1,64}$ and shows an inline error on mismatch;
//   no `join_room` is sent in that case.
// - On a valid Join:
//     1. dispatch JOIN_REQUESTED (session: idle → joining)
//     2. open the WebSocket if not already open
//     3. send a `join_room` envelope
// - Join button disabled while session === "joining".
// - On join_rejected, the reducer returns to idle and stores the
//   visible error in `session.joinError`; we render it here.
// - On join_accepted, we transition to pending-media (handled by
//   reducer). Phase 5 has no getUserMedia, so the UI stops there
//   per the two-phase-join rule.
// - The Leave button is available in pending-media; it sends
//   `leave_room` (best-effort) and resets the reducer to idle.

import { useState, type FormEvent } from "react";
import { ROOM_ID_REGEX } from "../types/contract";
import { useDispatch, useRootState } from "../state";
import { useSignalingClient } from "../signaling/provider";
import { makeEventLogEntry } from "../state/event-log";

// Best-effort signaling URL. For docker-compose dev the signaling
// server is exposed on the same host as the frontend at port 8080.
// Override via VITE_SIGNALING_URL if needed.
function resolveSignalingUrl(): string {
  const override = import.meta.env.VITE_SIGNALING_URL as string | undefined;
  if (override && override.length > 0) return override;
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = window.location.hostname || "localhost";
  return `${proto}//${host}:8080/ws`;
}

function makeRequestId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  // Fallback for test environments without crypto.randomUUID (vitest
  // jsdom provides it, but CI may not).
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function JoinForm() {
  const client = useSignalingClient();
  const dispatch = useDispatch();
  const { session } = useRootState();
  const [roomId, setRoomId] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const isJoining = session.session === "joining";
  const isPendingMedia = session.session === "pending-media";

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLocalError(null);
    const trimmed = roomId.trim();
    if (!ROOM_ID_REGEX.test(trimmed)) {
      const message = "Room ID must match ^[A-Za-z0-9._-]{1,64}$.";
      setLocalError(message);
      dispatch({
        type: "EVENT_LOG_APPEND",
        entry: makeEventLogEntry({
          type: "error_occurred",
          direction: "local",
          summary: `invalid room id: ${trimmed || "(empty)"}`,
          code: "invalid_room_id",
          transport: "signaling",
        }),
      });
      return;
    }

    dispatch({ type: "JOIN_REQUESTED", roomId: trimmed });

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

    const requestId = makeRequestId();
    try {
      client.send({
        v: 1,
        type: "join_room",
        roomId: trimmed,
        requestId,
        payload: {},
      });
      dispatch({
        type: "EVENT_LOG_APPEND",
        entry: makeEventLogEntry({
          type: "join_room_sent",
          direction: "local",
          summary: `join_room sent (roomId=${trimmed})`,
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
  }

  function handleLeave() {
    if (session.roomId) {
      try {
        client.send({
          v: 1,
          type: "leave_room",
          roomId: session.roomId,
          payload: {},
        });
      } catch {
        // Best-effort: WS may already be closed.
      }
    }
    client.close();
    dispatch({ type: "LEAVE_REQUESTED" });
    dispatch({
      type: "EVENT_LOG_APPEND",
      entry: makeEventLogEntry({
        type: "leave_requested",
        direction: "local",
        summary: "user clicked Leave",
        transport: "signaling",
      }),
    });
  }

  const serverError = session.joinError;

  return (
    <section aria-labelledby="join-form-heading" className="join-form">
      <h2 id="join-form-heading">Join a room</h2>
      <form onSubmit={handleSubmit} noValidate>
        <label htmlFor="room-id-input">Room ID</label>
        <input
          id="room-id-input"
          type="text"
          value={roomId}
          onChange={(e) => setRoomId(e.target.value)}
          placeholder="demo"
          autoComplete="off"
          disabled={isJoining || isPendingMedia}
          aria-invalid={localError !== null}
          aria-describedby={localError ? "room-id-error" : undefined}
        />
        <button
          type="submit"
          disabled={isJoining || isPendingMedia}
        >
          {isJoining ? "Joining…" : "Join"}
        </button>
        {isPendingMedia && (
          <button type="button" onClick={handleLeave}>
            Leave
          </button>
        )}
      </form>
      {localError && (
        <p id="room-id-error" role="alert" className="join-form__error">
          {localError}
        </p>
      )}
      {serverError && !localError && (
        <p role="alert" className="join-form__error">
          {serverError.message}
        </p>
      )}
    </section>
  );
}
