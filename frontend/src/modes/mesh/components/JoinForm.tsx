// Mesh JoinForm (T037). Validates room IDs against the same regex used
// by the v2 contract (`^[A-Za-z0-9._-]{1,64}$`) BEFORE sending
// `join_room`. Invalid IDs surface an inline error and never touch the
// signaling client (Spec FR-010 + EC-015).
//
// The form is route-aware via `useParams<{ roomId }>()` so opening
// `/mesh/demo` pre-fills the input. The user still has to click Join
// — auto-join would be a UX surprise (and would race the server's
// snapshot before the dispatcher is wired in tests).

import { useEffect, useState, type FormEvent } from "react";
import {
  MESH_CONTRACT_VERSION,
  ROOM_ID_REGEX,
} from "../signaling/schema";
import { useMeshDispatch, useMeshState } from "../state";
import { makeMeshEventEntry } from "../state/eventLog";
import type { MeshSignalingClient } from "../signaling/client";

export interface MeshJoinFormProps {
  client: MeshSignalingClient;
  // Resolved WebSocket URL (e.g. `wss://host/ws/mesh`). The provider
  // sets this; injected so tests can pass a mock URL.
  signalingUrl: string;
  // Optional default room id taken from the route param. Empty input
  // does not auto-fill server-side.
  initialRoomId?: string;
}

export function MeshJoinForm({
  client,
  signalingUrl,
  initialRoomId = "",
}: MeshJoinFormProps) {
  const dispatch = useMeshDispatch();
  const { local } = useMeshState();
  const [roomId, setRoomId] = useState(initialRoomId);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    // If the URL room id changes (route nav), refresh the input — but
    // only when the user has not yet typed anything different.
    setRoomId((current) =>
      current === "" || current === initialRoomId ? initialRoomId : current,
    );
  }, [initialRoomId]);

  const isJoining = local.fsm === "joining";
  const isAdmitted =
    local.fsm === "joined" ||
    local.fsm === "acquiring-media" ||
    local.fsm === "media-ready" ||
    local.fsm === "media-error" ||
    local.fsm === "in-room";

  async function runJoinFlow(targetRoomId: string) {
    try {
      await client.connect(signalingUrl);
    } catch (err) {
      dispatch({
        type: "MESH_EVENT_APPEND",
        entry: makeMeshEventEntry({
          scope: "room",
          type: "signaling_error",
          summary: `mesh ws connect failed: ${(err as Error).message ?? "unknown"}`,
        }),
      });
      dispatch({ type: "MESH_LOCAL_RESET" });
      return;
    }

    const requestId = crypto.randomUUID();
    try {
      client.send({
        v: MESH_CONTRACT_VERSION,
        type: "join_room",
        roomId: targetRoomId,
        requestId,
        payload: {},
      });
      dispatch({
        type: "MESH_EVENT_APPEND",
        entry: makeMeshEventEntry({
          scope: "room",
          type: "join_room_sent",
          summary: `join_room sent (roomId=${targetRoomId})`,
          detail: { requestId },
        }),
      });
    } catch (err) {
      dispatch({
        type: "MESH_EVENT_APPEND",
        entry: makeMeshEventEntry({
          scope: "room",
          type: "signaling_error",
          summary: `join_room send failed: ${(err as Error).message ?? "unknown"}`,
        }),
      });
      dispatch({ type: "MESH_LOCAL_RESET" });
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
        type: "MESH_EVENT_APPEND",
        entry: makeMeshEventEntry({
          scope: "room",
          type: "error_occurred",
          summary: `invalid mesh room id: ${trimmed || "(empty)"}`,
          detail: { code: "invalid_room_id" },
        }),
      });
      return;
    }
    dispatch({ type: "MESH_JOIN_REQUESTED", roomId: trimmed });
    await runJoinFlow(trimmed);
  }

  const formDisabled = isJoining || isAdmitted;
  const banner = local.errorBanner;

  return (
    <section
      aria-labelledby="mesh-join-form-heading"
      className="mesh-join-form"
      data-testid="mesh-join-form"
    >
      <h2 id="mesh-join-form-heading">Join a mesh room</h2>
      <form onSubmit={handleSubmit} noValidate>
        <label htmlFor="mesh-room-id-input">Room ID</label>
        <input
          id="mesh-room-id-input"
          data-testid="mesh-room-id-input"
          type="text"
          value={roomId}
          onChange={(e) => setRoomId(e.target.value)}
          placeholder="demo"
          autoComplete="off"
          disabled={formDisabled}
          aria-invalid={localError !== null}
          aria-describedby={localError ? "mesh-room-id-error" : undefined}
        />
        <button
          type="submit"
          disabled={formDisabled}
          data-testid="mesh-join-button"
        >
          {isJoining ? "Joining…" : "Join mesh room"}
        </button>
      </form>
      {localError && (
        <p
          id="mesh-room-id-error"
          role="alert"
          className="mesh-join-form__error"
          data-testid="mesh-join-form-error"
        >
          {localError}
        </p>
      )}
      {!localError && banner?.kind === "join-rejected" && (
        <p
          role="alert"
          className="mesh-join-form__error"
          data-testid="mesh-join-rejected-banner"
        >
          {banner.detail ?? "Join rejected."}
        </p>
      )}
    </section>
  );
}
