// Mesh dispatcher (T032) — parse inbound `/ws/mesh` frames, validate
// against the v2 schema, fan out to the matching reducer slice. The
// switch is exhaustive over `MeshServerMessage["type"]`; the default
// arm logs `error_occurred` and does not mutate state (data-model
// §A.6, plan §9.5 mapping).
//
// State-mutating arms in this batch (M4 + M5):
//   - join_accepted             → MESH_JOIN_ACCEPTED
//   - join_rejected             → MESH_JOIN_REJECTED
//   - mesh_roster_snapshot      → MESH_ROSTER_SNAPSHOT_APPLIED
//   - mesh_roster_update        → MESH_ROSTER_UPDATE_APPLIED (drops stale)
//   - participant_released      → MESH_PARTICIPANT_RELEASED
//
// Logged-only arms (no PC creation in this batch — M6+):
//   - pair_negotiation_instruction
//   - pair_offer / pair_answer / pair_ice_candidate / pair_failed
//   - pair_reconnect_instruction
//   - pair_media_state
//   - peer_left
//
// Validation failures (malformed JSON, unsupported `v`, payload
// validation failure) emit a peer/room-scoped `error_occurred` entry
// AND, when a client is supplied, send back an `error` envelope.

import type { Dispatch } from "react";
import {
  MESH_CONTRACT_VERSION,
  meshServerMessageSchema,
  type MeshServerMessage,
} from "../protocol/schema";
import type { MeshRootAction } from "../state";
import { makeMeshEventEntry } from "../state/eventLog";
import type { MeshSignalingClient } from "./client";
import type { MeshPairManager } from "../webrtc/pairManager";

interface DispatcherDeps {
  dispatch: Dispatch<MeshRootAction>;
  client: Pick<MeshSignalingClient, "send" | "close"> | null;
  // The local peer's UUID once `join_accepted` has been processed. Used
  // by the roster slice to exclude the local participant from `byPeerId`.
  // Returns `undefined` until the join handshake completes.
  getSelfPeerId: () => string | undefined;
  // Read the most recently-applied serverSeq for the roster slice. The
  // dispatcher uses this to classify an inbound `mesh_roster_update`
  // as applied vs dropped-stale BEFORE dispatching.
  getRosterServerSeq: () => number;
  // Local participant's FSM, read fresh on each inbound message. The
  // dispatcher uses this to decide whether to ignore a pair instruction
  // arriving before media-ready (M5 hard boundary).
  getLocalFsm?: () => string;
  // M6 PairManager. When present, pair_negotiation_instruction /
  // pair_offer / pair_answer are routed to it for SDP negotiation.
  // Absent during M4/M5 unit tests that exercise dispatcher-only paths.
  getPairManager?: () => MeshPairManager | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createMeshDispatcher(deps: DispatcherDeps) {
  return function handleInbound(raw: string): void {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      logError(deps, "malformed", "invalid JSON payload");
      return;
    }

    if (isPlainObject(json) && "v" in json && json.v !== MESH_CONTRACT_VERSION) {
      logError(
        deps,
        "unsupported_version",
        `unsupported mesh contract version: ${String(json.v)}`,
      );
      return;
    }

    const parsed = meshServerMessageSchema.safeParse(json);
    if (!parsed.success) {
      logError(deps, "malformed", parsed.error.message);
      return;
    }
    dispatchValidated(deps, parsed.data);
  };
}

function dispatchValidated(deps: DispatcherDeps, msg: MeshServerMessage): void {
  const { dispatch } = deps;
  switch (msg.type) {
    case "join_accepted": {
      const { peerId, admissionIndex } = msg.payload;
      dispatch({ type: "MESH_JOIN_ACCEPTED", peerId, admissionIndex });
      dispatch({
        type: "MESH_EVENT_APPEND",
        entry: makeMeshEventEntry({
          scope: "local",
          type: "join_accepted",
          summary: `joined room (peerId=${shortenId(peerId)}, admissionIndex=${admissionIndex})`,
        }),
      });
      return;
    }
    case "join_rejected": {
      dispatch({
        type: "MESH_JOIN_REJECTED",
        result: msg.payload.result,
        message: msg.payload.message,
      });
      dispatch({
        type: "MESH_EVENT_APPEND",
        entry: makeMeshEventEntry({
          scope: "room",
          type: "join_rejected",
          summary: `join rejected: ${msg.payload.message}`,
          detail: { result: msg.payload.result, reason: msg.payload.reason },
        }),
      });
      // Per contract §3.3 the server closes the WS on reject. Closing
      // locally keeps transport state coherent.
      deps.client?.close();
      return;
    }
    case "mesh_roster_snapshot": {
      const selfPeerId = deps.getSelfPeerId();
      dispatch({
        type: "MESH_ROSTER_SNAPSHOT_APPLIED",
        serverSeq: msg.payload.serverSeq,
        participants: msg.payload.participants,
        ...(selfPeerId !== undefined ? { selfPeerId } : {}),
      });
      dispatch({
        type: "MESH_EVENT_APPEND",
        entry: makeMeshEventEntry({
          scope: "room",
          type: "mesh_roster_snapshot_received",
          summary: `mesh roster snapshot received (n=${msg.payload.participants.length}, serverSeq=${msg.payload.serverSeq})`,
        }),
      });
      // Emit one peer-scoped log entry per remote participant in the
      // snapshot (FR-061 — every roster appearance is observable).
      for (const p of msg.payload.participants) {
        if (selfPeerId && p.peerId === selfPeerId) continue;
        dispatch({
          type: "MESH_EVENT_APPEND",
          entry: makeMeshEventEntry({
            scope: "peer",
            type: "mesh_roster_update_applied",
            summary: `peer ${shortenId(p.peerId)} present (presence=${p.presence})`,
            peerId: p.peerId,
            detail: {
              admissionIndex: p.admissionIndex,
              presence: p.presence,
              source: "snapshot",
            },
          }),
        });
      }
      return;
    }
    case "mesh_roster_update": {
      const selfPeerId = deps.getSelfPeerId();
      const currentSeq = deps.getRosterServerSeq();
      const stale = msg.payload.serverSeq <= currentSeq;
      if (stale) {
        // Drop without mutating roster state; surface the drop as a
        // peer-scoped event-log entry per FR-061 + plan §9.5.
        dispatch({
          type: "MESH_EVENT_APPEND",
          entry: makeMeshEventEntry({
            scope: "peer",
            type: "mesh_roster_update_dropped_stale",
            summary: `dropped stale mesh_roster_update for peer ${shortenId(msg.payload.subjectPeerId)} (got serverSeq=${msg.payload.serverSeq}, have=${currentSeq})`,
            peerId: msg.payload.subjectPeerId,
            detail: {
              serverSeq: msg.payload.serverSeq,
              previousServerSeq: currentSeq,
              presence: msg.payload.presence,
              reason: msg.payload.reason,
            },
          }),
        });
        return;
      }
      dispatch({
        type: "MESH_ROSTER_UPDATE_APPLIED",
        serverSeq: msg.payload.serverSeq,
        subjectPeerId: msg.payload.subjectPeerId,
        admissionIndex: msg.payload.admissionIndex,
        presence: msg.payload.presence,
        ...(selfPeerId !== undefined ? { selfPeerId } : {}),
      });
      dispatch({
        type: "MESH_EVENT_APPEND",
        entry: makeMeshEventEntry({
          scope: "peer",
          type: "mesh_roster_update_applied",
          summary: `peer ${shortenId(msg.payload.subjectPeerId)} → ${msg.payload.presence} (${msg.payload.reason})`,
          peerId: msg.payload.subjectPeerId,
          detail: {
            serverSeq: msg.payload.serverSeq,
            presence: msg.payload.presence,
            reason: msg.payload.reason,
          },
        }),
      });
      // M12 / T090 — Path B: roster `left` for a remote peer also tears
      // down our PairContext for that peer (idempotent with `peer_left`).
      // The local participant's own `left` is handled by the leave path
      // and is not a remote-cleanup trigger.
      if (
        msg.payload.presence === "left" &&
        (!selfPeerId || msg.payload.subjectPeerId !== selfPeerId)
      ) {
        const manager = deps.getPairManager?.() ?? null;
        manager?.closePairByRemotePeerId(msg.payload.subjectPeerId);
      }
      return;
    }
    case "participant_released": {
      dispatch({
        type: "MESH_PARTICIPANT_RELEASED",
        ...(msg.payload.detail !== undefined
          ? { detail: msg.payload.detail }
          : {}),
      });
      dispatch({
        type: "MESH_EVENT_APPEND",
        entry: makeMeshEventEntry({
          scope: "local",
          type: "participant_released",
          summary: `slot released (${msg.payload.reason})`,
          detail: {
            result: msg.payload.result,
            reason: msg.payload.reason,
            detailText: msg.payload.detail,
          },
        }),
      });
      return;
    }
    case "pair_negotiation_instruction":
    case "pair_reconnect_instruction": {
      // M5 hard boundary: a pair instruction received while the local
      // participant is not media-ready MUST NOT create a PC.
      const fsm = deps.getLocalFsm?.();
      const isReady = fsm === "media-ready" || fsm === "in-room";
      const subjectPeerId = msg.payload.remotePeer.peerId;
      const manager = isReady ? deps.getPairManager?.() ?? null : null;
      dispatch({
        type: "MESH_EVENT_APPEND",
        entry: makeMeshEventEntry({
          scope: "pair",
          type: isReady ? "future_phase_message" : "error_occurred",
          summary: isReady
            ? `pair instruction received for pair ${msg.payload.pairId} (role=${msg.payload.role}, epoch=${msg.payload.pairEpoch})`
            : `pair instruction received before media-ready — ignored (pair ${msg.payload.pairId})`,
          peerId: subjectPeerId,
          pairId: msg.payload.pairId,
          detail: {
            type: msg.type,
            role: msg.payload.role,
            pairEpoch: msg.payload.pairEpoch,
            localFsm: fsm,
          },
        }),
      });
      if (manager && msg.type === "pair_negotiation_instruction") {
        void manager.handleNewcomerInstructions([
          {
            pairId: msg.payload.pairId,
            pairEpoch: msg.payload.pairEpoch,
            role: msg.payload.role,
            remotePeerId: msg.payload.remotePeer.peerId,
            remoteAdmissionIndex: msg.payload.remotePeer.admissionIndex,
            iceServers: msg.payload.iceServers as RTCIceServer[],
          },
        ]);
      } else if (manager && msg.type === "pair_reconnect_instruction") {
        // M11 / T085 — fresh-attempt rebuild for one pair only.
        void manager.handlePairReconnectInstruction({
          pairId: msg.payload.pairId,
          pairEpoch: msg.payload.pairEpoch,
          role: msg.payload.role,
          remotePeerId: msg.payload.remotePeer.peerId,
          remoteAdmissionIndex: msg.payload.remotePeer.admissionIndex,
          iceServers: msg.payload.iceServers as RTCIceServer[],
        });
      }
      return;
    }
    case "pair_offer": {
      const manager = deps.getPairManager?.() ?? null;
      const subjectPeerId = msg.from;
      const pairId = msg.payload.pairId;
      if (manager) {
        void manager.handlePairOffer({
          pairId,
          pairEpoch: msg.payload.pairEpoch,
          sdp: msg.payload.sdp as RTCSessionDescriptionInit,
        });
      } else {
        dispatch({
          type: "MESH_EVENT_APPEND",
          entry: subjectPeerId
            ? makeMeshEventEntry({
                scope: "pair",
                type: "future_phase_message",
                summary: `pair_offer received for pair ${pairId} (no PairManager wired)`,
                peerId: subjectPeerId,
                pairId,
                detail: { type: msg.type, pairEpoch: msg.payload.pairEpoch },
              })
            : makeMeshEventEntry({
                scope: "room",
                type: "future_phase_message",
                summary: `pair_offer received for pair ${pairId} (no PairManager wired)`,
                detail: { type: msg.type, pairEpoch: msg.payload.pairEpoch },
              }),
        });
      }
      return;
    }
    case "pair_answer": {
      const manager = deps.getPairManager?.() ?? null;
      const subjectPeerId = msg.from;
      const pairId = msg.payload.pairId;
      if (manager) {
        void manager.handlePairAnswer({
          pairId,
          pairEpoch: msg.payload.pairEpoch,
          sdp: msg.payload.sdp as RTCSessionDescriptionInit,
        });
      } else {
        dispatch({
          type: "MESH_EVENT_APPEND",
          entry: subjectPeerId
            ? makeMeshEventEntry({
                scope: "pair",
                type: "future_phase_message",
                summary: `pair_answer received for pair ${pairId} (no PairManager wired)`,
                peerId: subjectPeerId,
                pairId,
                detail: { type: msg.type, pairEpoch: msg.payload.pairEpoch },
              })
            : makeMeshEventEntry({
                scope: "room",
                type: "future_phase_message",
                summary: `pair_answer received for pair ${pairId} (no PairManager wired)`,
                detail: { type: msg.type, pairEpoch: msg.payload.pairEpoch },
              }),
        });
      }
      return;
    }
    case "pair_ice_candidate": {
      const manager = deps.getPairManager?.() ?? null;
      const pairId = msg.payload.pairId;
      if (manager) {
        void manager.handlePairIceCandidate({
          pairId,
          pairEpoch: msg.payload.pairEpoch,
          candidate: msg.payload.candidate as RTCIceCandidateInit | null,
        });
      } else {
        const subjectPeerId = msg.from;
        dispatch({
          type: "MESH_EVENT_APPEND",
          entry: subjectPeerId
            ? makeMeshEventEntry({
                scope: "pair",
                type: "future_phase_message",
                summary: `pair_ice_candidate received for pair ${pairId} (no PairManager wired)`,
                peerId: subjectPeerId,
                pairId,
                detail: { type: msg.type, pairEpoch: msg.payload.pairEpoch },
              })
            : makeMeshEventEntry({
                scope: "room",
                type: "future_phase_message",
                summary: `pair_ice_candidate received for pair ${pairId} (no PairManager wired)`,
                detail: { type: msg.type, pairEpoch: msg.payload.pairEpoch },
              }),
        });
      }
      return;
    }
    case "pair_failed": {
      // M11 / T081 — inbound `pair_failed` from the remote endpoint.
      // Routed to the manager so ONLY the matching PairContext is
      // marked failed (FR-025); other pairs are not touched. When no
      // PairManager is wired (M4/M5 unit-test contexts) we fall back
      // to a logged-only event so dispatcher tests still pass.
      const subjectPeerId = msg.from;
      const pairId = msg.payload.pairId;
      const manager = deps.getPairManager?.() ?? null;
      if (manager) {
        manager.handlePairFailed({
          pairId,
          pairEpoch: msg.payload.pairEpoch,
          reason: msg.payload.reason,
          ...(msg.payload.detail !== undefined
            ? { detail: msg.payload.detail }
            : {}),
        });
        return;
      }
      const baseSummary = `received ${msg.type} for pair ${pairId} (no PairManager wired)`;
      dispatch({
        type: "MESH_EVENT_APPEND",
        entry: subjectPeerId
          ? makeMeshEventEntry({
              scope: "pair",
              type: "future_phase_message",
              summary: baseSummary,
              peerId: subjectPeerId,
              pairId,
              detail: {
                type: msg.type,
                pairEpoch: msg.payload.pairEpoch,
                reason: msg.payload.reason,
              },
            })
          : makeMeshEventEntry({
              scope: "room",
              type: "future_phase_message",
              summary: baseSummary,
              detail: {
                type: msg.type,
                pairEpoch: msg.payload.pairEpoch,
                reason: msg.payload.reason,
              },
            }),
      });
      return;
    }
    case "pair_media_state": {
      const subjectPeerId = msg.from;
      // Without `from` we can't map the state to a remote tile, so we
      // surface the malformed envelope as a room-scoped error instead
      // of touching any roster entry. (The server always stamps `from`
      // on relay; this branch protects test fixtures + future
      // contract drift.)
      if (!subjectPeerId) {
        dispatch({
          type: "MESH_EVENT_APPEND",
          entry: makeMeshEventEntry({
            scope: "room",
            type: "error_occurred",
            summary:
              "pair_media_state received without `from` — cannot route to a remote tile",
            detail: { code: "malformed", type: msg.type },
          }),
        });
        return;
      }
      const selfPeerId = deps.getSelfPeerId();
      if (selfPeerId && subjectPeerId === selfPeerId) {
        // The server fans out to other participants only — receiving
        // our own state back would be a server bug. Log + drop without
        // mutating local-media state (M9 isolation rule).
        dispatch({
          type: "MESH_EVENT_APPEND",
          entry: makeMeshEventEntry({
            scope: "local",
            type: "error_occurred",
            summary:
              "pair_media_state received with from=self — ignored (server fan-out should skip the sender)",
            detail: { code: "internal_error", type: msg.type },
          }),
        });
        return;
      }
      dispatch({
        type: "MESH_REMOTE_MEDIA_STATE_APPLIED",
        subjectPeerId,
        microphone: msg.payload.microphone,
        camera: msg.payload.camera,
        screenShare: msg.payload.screenShare,
      });
      dispatch({
        type: "MESH_EVENT_APPEND",
        entry: makeMeshEventEntry({
          scope: "peer",
          type: "mesh_media_state_received",
          summary: `pair_media_state received from peer ${shortenId(subjectPeerId)} (signaling metadata path)`,
          peerId: subjectPeerId,
          detail: {
            transport: "signaling",
            path: "metadata",
            remotePeerId: subjectPeerId,
          },
        }),
      });
      return;
    }
    case "peer_left": {
      dispatch({
        type: "MESH_EVENT_APPEND",
        entry: makeMeshEventEntry({
          scope: "peer",
          type: "future_phase_message",
          summary: `peer ${shortenId(msg.payload.peerId)} left (${msg.payload.reason})`,
          peerId: msg.payload.peerId,
          detail: { reason: msg.payload.reason },
        }),
      });
      // M12 / T090 — Path B: tear down only the PairContext local↔leaver.
      // Idempotent with the matching `mesh_roster_update presence=left`
      // (FR — either order works). Local tracks and healthy pairs are
      // untouched.
      const manager = deps.getPairManager?.() ?? null;
      manager?.closePairByRemotePeerId(msg.payload.peerId);
      return;
    }
    case "error": {
      // M11 / T083 — pair-scoped errors (the server returns
      // `stale_pair_epoch` / `malformed` etc. with `context.pairId`
      // when a `reconnect_pair` request loses a simultaneous-click
      // race or names a pair that is not in the failed state). Clear
      // the per-pair `reconnectRequested` flag so the Reconnect button
      // becomes clickable again.
      const ctx = msg.payload.context;
      const pairId =
        ctx && typeof ctx === "object" && typeof ctx["pairId"] === "string"
          ? (ctx["pairId"] as string)
          : undefined;
      if (pairId) {
        const manager = deps.getPairManager?.() ?? null;
        manager?.clearReconnectRequested(pairId);
      }
      dispatch({
        type: "MESH_EVENT_APPEND",
        entry: makeMeshEventEntry({
          scope: "room",
          type: "error_occurred",
          summary: `server error: ${msg.payload.message}`,
          detail: pairId
            ? { code: msg.payload.code, pairId }
            : { code: msg.payload.code },
        }),
      });
      return;
    }
    default: {
      // Exhaustiveness check. Any new server message must be added to
      // MeshServerMessage type AND a switch arm here, otherwise this
      // line stops compiling.
      const _exhaustive: never = msg;
      void _exhaustive;
      logError(deps, "malformed", "unknown mesh message type");
    }
  }
}

function logError(
  { dispatch, client }: DispatcherDeps,
  code: "malformed" | "unsupported_version",
  message: string,
): void {
  dispatch({
    type: "MESH_EVENT_APPEND",
    entry: makeMeshEventEntry({
      scope: "room",
      type: "error_occurred",
      summary: `error occurred: ${code}`,
      detail: { code, message: message.slice(0, 160) },
    }),
  });
  if (client) {
    try {
      client.send({
        v: MESH_CONTRACT_VERSION,
        type: "error",
        payload: {
          code,
          message: truncate(message, 200),
        },
      });
    } catch {
      // send failure is already accounted for by the log entry above.
    }
  }
}

function shortenId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
