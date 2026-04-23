// Signaling dispatcher — parse inbound WS frames, validate, dispatch.
//
// Phase 5 scope:
// - Parse raw strings as JSON.
// - Validate through `envelopeBaseSchema` + the per-type schema in
//   `schemasByType`.
// - On success: emit a reducer action. For Phase 5 the meaningfully
//   mutating actions are `JOIN_ACCEPTED`, `JOIN_REJECTED`, and
//   `PEER_PRESENCE_CHANGED`. Other canonical types (media_ready,
//   media_failed, ready_for_offer, offer, answer, ice_candidate,
//   media_state, peer_left, participant_released, leave_room, error)
//   are logged via the event log (so we never silently swallow a
//   canonical message) but do not mutate state yet — those phases
//   will extend this dispatcher.
// - On failure (malformed JSON, unsupported `v`, unknown type, payload
//   validation failure): append an "error occurred" event log entry
//   AND send an `error` message back through the WS client when
//   possible. No reducer state is mutated on validation failure
//   (data-model §B.9).

import type { Dispatch } from "react";
import type { RootAction } from "../state";
import { makeEventLogEntry } from "../state/event-log";
import {
  envelopeBaseSchema,
  schemasByType,
  type ErrorMessage,
  type JoinAcceptedMessage,
  type JoinRejectedMessage,
  type PeerPresenceChangedMessage,
  type SignalingMessage,
} from "./schema";
import type { SignalingClient } from "./client";

interface DispatcherDeps {
  dispatch: Dispatch<RootAction>;
  client: Pick<SignalingClient, "send" | "close"> | null;
}

export function createSignalingDispatcher(deps: DispatcherDeps) {
  return function handleInbound(raw: string): void {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      logError(deps, "malformed", "invalid JSON payload");
      return;
    }

    const envelope = envelopeBaseSchema.safeParse(json);
    if (!envelope.success) {
      // If envelope parse failed we cannot trust `v` or `type`. Treat as
      // malformed. The `v != 1` case is also caught by this path because
      // `versionSchema` rejects it.
      const containsWrongVersion =
        typeof (json as { v?: unknown }).v !== "undefined" &&
        (json as { v?: unknown }).v !== 1;
      const code = containsWrongVersion ? "unsupported_version" : "malformed";
      logError(deps, code, envelope.error.message);
      return;
    }

    const parsedType = envelope.data.type;
    const schema = schemasByType[parsedType];
    if (!schema) {
      // The enum in envelopeBaseSchema means we should never get here,
      // but guard anyway so an unknown type produces the right log and
      // error response rather than a silent pass.
      logError(deps, "malformed", `unknown message type: ${parsedType}`);
      return;
    }

    const perType = schema.safeParse(json);
    if (!perType.success) {
      logError(deps, "malformed", perType.error.message);
      return;
    }

    dispatchValidated(deps, perType.data as SignalingMessage);
  };
}

function dispatchValidated(
  { dispatch, client }: DispatcherDeps,
  msg: SignalingMessage,
): void {
  switch (msg.type) {
    case "join_accepted": {
      const accepted = msg as JoinAcceptedMessage;
      dispatch({ type: "JOIN_ACCEPTED", message: accepted });
      dispatch({
        type: "EVENT_LOG_APPEND",
        entry: makeEventLogEntry({
          type: "room_joined",
          direction: "system",
          summary: `room joined (peerId=${accepted.payload.peerId.slice(
            0,
            8,
          )}…, admissionOrder=${accepted.payload.admissionOrder})`,
          transport: "signaling",
        }),
      });
      return;
    }
    case "join_rejected": {
      const rejected = msg as JoinRejectedMessage;
      dispatch({ type: "JOIN_REJECTED", message: rejected });
      dispatch({
        type: "EVENT_LOG_APPEND",
        entry: makeEventLogEntry({
          type: "error_occurred",
          direction: "system",
          summary: `join rejected: ${rejected.payload.message}`,
          reason: rejected.payload.reason,
          code: rejected.payload.result,
          transport: "signaling",
        }),
      });
      // Contract §3.3: client receipt of join_rejected shows the
      // error, logs it, closes the WS, and returns to idle. The
      // server also closes its side on reject, but closing locally
      // keeps the transport state coherent and idempotent.
      client?.close();
      return;
    }
    case "peer_presence_changed": {
      const presence = msg as PeerPresenceChangedMessage;
      dispatch({ type: "PEER_PRESENCE_CHANGED", message: presence });
      dispatch({
        type: "EVENT_LOG_APPEND",
        entry: makeEventLogEntry({
          type: "peer_presence_changed",
          direction: "system",
          summary: `peer ${shortenId(presence.payload.subjectPeerId)} → ${presence.payload.presence} (${presence.payload.reason})`,
          reason: presence.payload.reason,
          transport: "signaling",
        }),
      });
      return;
    }
    // Canonical messages handled in later phases. We log them so we
    // never "silently swallow" a known type; state mutation belongs to
    // future phases.
    case "media_ready":
    case "media_failed":
    case "ready_for_offer":
    case "offer":
    case "answer":
    case "ice_candidate":
    case "media_state":
    case "peer_left":
    case "participant_released":
    case "leave_room":
      dispatch({
        type: "EVENT_LOG_APPEND",
        entry: makeEventLogEntry({
          type: msg.type,
          direction: "system",
          summary: `received ${msg.type} (future-phase handler)`,
          transport: "signaling",
        }),
      });
      return;
    case "error": {
      const err = msg as ErrorMessage;
      dispatch({
        type: "EVENT_LOG_APPEND",
        entry: makeEventLogEntry({
          type: "error_occurred",
          direction: "remote",
          summary: `server error: ${err.payload.message}`,
          code: err.payload.code,
          transport: "signaling",
        }),
      });
      return;
    }
    // join_room, leave_room — these are outbound shapes; if we see them
    // inbound, fall through to ignore (logged by per-type branch above).
    case "join_room":
      dispatch({
        type: "EVENT_LOG_APPEND",
        entry: makeEventLogEntry({
          type: "error_occurred",
          direction: "system",
          summary: "unexpected inbound join_room",
          code: "malformed",
          transport: "signaling",
        }),
      });
      return;
    default: {
      const _exhaustive: never = msg;
      void _exhaustive;
    }
  }
}

function logError(
  { dispatch, client }: DispatcherDeps,
  code:
    | "malformed"
    | "unsupported_version"
    | "internal_error"
    | string,
  message: string,
): void {
  dispatch({
    type: "EVENT_LOG_APPEND",
    entry: makeEventLogEntry({
      type: "error_occurred",
      direction: "system",
      summary: `error occurred: ${code}`,
      code,
      reason: message.slice(0, 120),
      transport: "signaling",
    }),
  });
  if (client) {
    try {
      // Build a minimal v1 error envelope. We omit roomId because we may
      // not know it (e.g., unsupported_version or malformed envelope).
      client.send({
        v: 1,
        type: "error",
        payload: {
          code: normalizeErrorCode(code),
          message: truncate(message, 200),
        },
      } as ErrorMessage);
    } catch {
      // If the send itself fails (transport down, schema rejects),
      // swallow — the event-log entry already records the cause.
    }
  }
}

function normalizeErrorCode(code: string): ErrorMessage["payload"]["code"] {
  switch (code) {
    case "unsupported_version":
      return "unsupported_version";
    case "malformed":
      return "malformed";
    default:
      return "malformed";
  }
}

function shortenId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
