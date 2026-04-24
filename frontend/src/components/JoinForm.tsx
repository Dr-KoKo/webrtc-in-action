// JoinForm — room-ID entry + Join / Retry / Leave affordances.
//
// Phase 5 + Phase 6 behavior:
// - Client-side validates room ID against the contract regex
//   ^[A-Za-z0-9._-]{1,64}$ and shows an inline error on mismatch;
//   no `join_room` is sent in that case.
// - On a valid Join:
//     1. dispatch JOIN_REQUESTED (session: idle → joining)
//     2. open the WebSocket if not already open
//     3. send a `join_room` envelope
// - On join_accepted, the reducer moves to pending-media; the
//   LocalMediaProvider then runs getUserMedia and drives media_ready /
//   media_failed. On success it dispatches MEDIA_READY_SENT (→
//   waiting-for-peer).
// - On server participant_released(media_failed), the reducer
//   transitions pending-media → media-error. The Retry button
//   dispatches RETRY_REQUESTED (media-error → joining) and re-sends
//   join_room on the existing WS; `client.connect()` is a no-op when
//   already open (data-model §B.1, contract §3.3).
// - The Leave button is available in pending-media and media-error;
//   it sends `leave_room` (best-effort), closes the WS, and resets
//   the reducer to idle. LocalMediaProvider stops tracks when the
//   session returns to idle (Path A local-tracks portion, §C.5).

import { useState, type FormEvent } from "react";
import { CONTRACT_VERSION, ROOM_ID_REGEX } from "../types/contract";
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

export function JoinForm() {
  const client = useSignalingClient();
  const dispatch = useDispatch();
  const { session } = useRootState();
  const [roomId, setRoomId] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const isJoining = session.session === "joining";
  const isPendingMedia = session.session === "pending-media";
  const isMediaError = session.session === "media-error";
  const showLeave = isPendingMedia || isMediaError;

  async function runJoinFlow(targetRoomId: string) {
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
        roomId: targetRoomId,
        requestId,
        payload: {},
      });
      dispatch({
        type: "EVENT_LOG_APPEND",
        entry: makeEventLogEntry({
          type: "join_room_sent",
          direction: "local",
          summary: `join_room sent (roomId=${targetRoomId})`,
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
    await runJoinFlow(trimmed);
  }

  async function handleRetry() {
    const previousRoomId = session.roomId;
    if (!previousRoomId) return;
    setLocalError(null);
    dispatch({ type: "RETRY_REQUESTED" });
    dispatch({
      type: "EVENT_LOG_APPEND",
      entry: makeEventLogEntry({
        type: "retry_requested",
        direction: "local",
        summary: `retry media acquisition (roomId=${previousRoomId})`,
        transport: "signaling",
      }),
    });
    await runJoinFlow(previousRoomId);
  }

  function handleLeave() {
    if (session.roomId) {
      try {
        client.send({
          v: CONTRACT_VERSION,
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
  const formDisabled = isJoining || isPendingMedia || isMediaError;

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
          disabled={formDisabled}
          aria-invalid={localError !== null}
          aria-describedby={localError ? "room-id-error" : undefined}
        />
        <button type="submit" disabled={formDisabled}>
          {isJoining ? "Joining…" : "Join"}
        </button>
        {isMediaError && (
          <button type="button" onClick={handleRetry}>
            Retry
          </button>
        )}
        {showLeave && (
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
      {isMediaError && (
        <p role="alert" className="join-form__error">
          Camera or microphone unavailable. Use Retry to try again,
          or Leave to return to idle.
        </p>
      )}
    </section>
  );
}
