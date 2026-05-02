// Signaling dispatcher — parse inbound WS frames, validate, dispatch.
//
// Phase 5 scope:
// - Parse raw strings as JSON.
// - Validate through the signaling-message discriminated union (schema.ts).
// - On success: emit a reducer action. For Phase 5 the meaningfully
//   mutating actions are `JOIN_ACCEPTED`, `JOIN_REJECTED`, and
//   `PEER_PRESENCE_CHANGED`. Other canonical types (media_ready,
//   media_failed, ready_for_offer, offer, answer, ice_candidate,
//   media_state, peer_left, participant_released, leave_room, error)
//   are logged via the event log (so we never silently swallow a
//   canonical message) but do not mutate state yet — those phases
//   will extend this dispatcher.
// - On failure (malformed JSON, unsupported `v`, payload validation
//   failure): append an "error occurred" event log entry AND send an
//   `error` message back through the WS client when possible. No
//   reducer state is mutated on validation failure (data-model §B.9).

import type { Dispatch } from "react";
import type { RootAction } from "../state";
import { makeEventLogEntry } from "../state/event-log";
import {
  CONTRACT_VERSION,
  signalingMessageSchema,
  type ErrorMessage,
  type JoinAcceptedMessage,
  type JoinRejectedMessage,
  type MediaStateMessage,
  type ParticipantReleasedMessage,
  type PeerPresenceChangedMessage,
  type SignalingMessage,
} from "../protocol/schema";
import type { SignalingClient } from "./client";

interface DispatcherDeps {
  dispatch: Dispatch<RootAction>;
  client: Pick<SignalingClient, "send" | "close"> | null;
}

type ClientErrorCode = Extract<
  ErrorMessage["payload"]["code"],
  "malformed" | "unsupported_version"
>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value)
  );
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

    // Classify an `unsupported_version` before schema parsing. The
    // discriminated union may short-circuit on an invalid `type` and
    // never emit a `["v"]` issue, which would silently demote an
    // unsupported-version message to `malformed`.
    if (isPlainObject(json) && "v" in json && json.v !== CONTRACT_VERSION) {
      logError(deps, "unsupported_version", `unsupported contract version: ${String(json.v)}`);
      return;
    }

    const parsed = signalingMessageSchema.safeParse(json);
    if (!parsed.success) {
      logError(deps, "malformed", parsed.error.message);
      return;
    }

    dispatchValidated(deps, parsed.data);
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
      // When the remote peer is gone (left / released), clear the
      // remote media triplet so the UI does not render the departed
      // peer's last mic/camera state on top of a subsequent pairing.
      // `left`/`released` are never delivered to the subject itself
      // (the server broadcasts to the remaining participant only), so
      // we can clear unconditionally.
      if (
        presence.payload.presence === "left" ||
        presence.payload.presence === "released"
      ) {
        dispatch({ type: "REMOTE_MEDIA_STATE_CLEARED" });
      }
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
    case "participant_released": {
      const released = msg as ParticipantReleasedMessage;
      // Phase 6: only the media_failed branch drives a reducer
      // transition (pending-media → media-error). The disconnect
      // branch is logged here; the remaining-peer cleanup lands in a
      // later phase (data-model §B.1 Failure-path rules).
      dispatch({ type: "PARTICIPANT_RELEASED", message: released });
      dispatch({
        type: "EVENT_LOG_APPEND",
        entry: makeEventLogEntry({
          type: "participant_released",
          direction: "system",
          summary: `slot released (${released.payload.reason})`,
          reason: released.payload.reason,
          code: released.payload.result,
          transport: "signaling",
        }),
      });
      return;
    }
    // Phase 7 + Phase 8 — negotiation / ICE messages are handled by a
    // dedicated listener registered by `PeerConnectionProvider`
    // (which parses the same frame through the shared Zod schema and
    // emits richer event-log entries: `ready_for_offer_received`,
    // `offer_received`, `answer_received`, `ice_candidate_received`,
    // etc.). The dispatcher returns without logging so each inbound
    // negotiation / trickle frame produces exactly one event-log
    // entry from the PC provider rather than a duplicate placeholder
    // row here.
    case "ready_for_offer":
    case "offer":
    case "answer":
    case "ice_candidate":
      return;
    case "media_state": {
      const remote = msg as MediaStateMessage;
      const triplet = remote.payload;
      dispatch({
        type: "REMOTE_MEDIA_STATE_RECEIVED",
        triplet,
      });
      // One event-log entry per inbound message (T073 DoD). Direction
      // is "remote" because the message originated on the peer; the
      // summary is safe (enum values only — no PII).
      dispatch({
        type: "EVENT_LOG_APPEND",
        entry: makeEventLogEntry({
          type: "media_state",
          direction: "remote",
          summary: `media_state received (mic=${triplet.microphone}, camera=${triplet.camera}, screen=${triplet.screenShare})`,
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
    case "peer_left":
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
  code: ClientErrorCode,
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
      // Minimal v1 error envelope. `roomId` is omitted because an
      // unsupported-version or malformed envelope may not carry one we
      // can trust.
      client.send({
        v: CONTRACT_VERSION,
        type: "error",
        payload: {
          code,
          message: truncate(message, 200),
        },
      });
    } catch {
      // Send itself failed (transport down, schema rejects) — the
      // event-log entry above already records the cause.
    }
  }
}

function shortenId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
