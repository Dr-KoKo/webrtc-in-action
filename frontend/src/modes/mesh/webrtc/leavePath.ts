// M12 / T089 — Local Leave path (Path A; data-model §C.3).
//
// Orchestrates the user-initiated graceful Leave:
//
//   1. dispatch MESH_LEAVE_REQUESTED            (fsm: * → leaving)
//   2. append event-log entry "leave requested"
//   3. send leave_room over /ws/mesh             (only if WS open)
//   4. close every RTCDataChannel + RTCPeerConnection (via pairManager)
//   5. stop screen-share track if active
//   6. stop every local audio/video track
//   7. close the mesh WebSocket
//   8. clear PairContext map  (closeAll already dispatches MESH_PAIR_REMOVED)
//   9. clear roster + chat + localMedia + pairs
//   10. dispatch MESH_LEAVE_COMPLETED              (fsm: leaving → left)
//
// Idempotent: a second invocation while `leaving` / `left` is a no-op
// at the FSM gate (the reducer drops MESH_LEAVE_REQUESTED in those
// states) and at the orchestrator gate (`running` flag) — no duplicate
// `leave_room` send, no double-close.
//
// Hard boundary:
//   - MUST NOT enter terminal `failed` state (Leave is not a failure).
//   - MUST NOT broadcast pair_failed for the closing pairs (they go to
//     `closed`, not `failed`).
//   - MUST NOT auto-reconnect.

import type { Dispatch } from "react";
import type { MeshRootAction } from "../state";
import { makeMeshEventEntry } from "../state/eventLog";
import {
  MESH_CONTRACT_VERSION,
  type MeshClientMessage,
} from "../protocol/schema";
import type { MeshPairManager } from "./pairManager";

export interface MeshLeavePathDeps {
  readonly dispatch: Dispatch<MeshRootAction>;
  // Sends one outbound mesh frame; throws if transport not open. The
  // leave path catches that and continues — closing the WS is the
  // server's authoritative signal anyway.
  readonly send: (message: MeshClientMessage) => void;
  // Reads the mesh transport state at call time. Used to gate the
  // optional `leave_room` send so we don't surface a spurious
  // signaling error when the WS is already closed.
  readonly isSocketOpen: () => boolean;
  // Closes the mesh WebSocket. Idempotent on the underlying client.
  readonly closeSocket: () => void;
  readonly pairManager: MeshPairManager | null;
  readonly getRoomId: () => string | null;
  readonly getLocalStream: () => MediaStream | null;
  readonly getActiveScreenTrack: () => MediaStreamTrack | null;
  // Drops the cached self-tile MediaStream so LocalPreview clears.
  readonly publishLocalStream: (stream: MediaStream | null) => void;
  // Best-effort cleanup of the screen-share controller's underlying
  // MediaStream (if a controller is owned by the caller).
  readonly disposeScreenShare?: () => void;
}

export interface MeshLeavePath {
  readonly run: () => void;
  readonly isRunning: () => boolean;
  readonly hasRun: () => boolean;
}

export function createMeshLeavePath(deps: MeshLeavePathDeps): MeshLeavePath {
  let running = false;
  let done = false;

  function appendEvent(
    entry: Parameters<typeof makeMeshEventEntry>[0],
  ): void {
    deps.dispatch({
      type: "MESH_EVENT_APPEND",
      entry: makeMeshEventEntry(entry),
    });
  }

  function run(): void {
    if (running || done) return;
    running = true;

    deps.dispatch({ type: "MESH_LEAVE_REQUESTED" });
    appendEvent({
      scope: "local",
      type: "future_phase_message",
      summary: "leave requested",
      detail: { kind: "mesh_leave_requested" },
    });

    // Send leave_room first so the server has a chance to broadcast
    // graceful_leave before we close the socket. Skipped silently when
    // the WS is already closed (signaling-error path or stale client).
    const roomId = deps.getRoomId();
    if (roomId && deps.isSocketOpen()) {
      try {
        deps.send({
          v: MESH_CONTRACT_VERSION,
          type: "leave_room",
          roomId,
          payload: {},
        });
      } catch (err) {
        appendEvent({
          scope: "local",
          type: "signaling_error",
          summary: `failed to send leave_room: ${
            (err as Error).message ?? "unknown"
          }`,
        });
      }
    }

    // Stop the screen-share controller's underlying stream (if any).
    // The pairManager's pc.close() call below already breaks media
    // delivery; this just releases the OS-level "this tab is sharing"
    // indicator promptly.
    try {
      deps.disposeScreenShare?.();
    } catch {
      // best-effort
    }

    // Close every PairContext (pc + dc + iceBuffer) and drop the pair
    // views from the store. Walks `failedReported` flags untouched —
    // closed pairs go to `closed`, not `failed`.
    deps.pairManager?.closeAll();

    // Stop all local media tracks (camera + microphone). Screen-share
    // tracks live on a separate stream owned by the controller, which
    // disposeScreenShare() above stops.
    const stream = deps.getLocalStream();
    if (stream) {
      for (const t of stream.getTracks()) {
        try {
          t.stop();
        } catch {
          // already ended
        }
      }
    }
    // Defensive: stop any active screen track that the controller may
    // not have stopped (e.g. dispose called before stop completes).
    const screenTrack = deps.getActiveScreenTrack();
    if (screenTrack) {
      try {
        screenTrack.stop();
      } catch {
        // already ended
      }
    }
    deps.publishLocalStream(null);

    // Reset every mesh-scoped slice so re-entering the route via the
    // join form starts from a clean state. The local FSM transition
    // to `left` happens last so observers can see "leaving" while the
    // teardown completes.
    deps.dispatch({ type: "MESH_PAIRS_RESET" });
    deps.dispatch({ type: "MESH_ROSTER_RESET" });
    deps.dispatch({ type: "MESH_CHAT_RESET" });
    deps.dispatch({ type: "MESH_LOCAL_MEDIA_RESET" });

    // Close the WebSocket last. The server has already received
    // leave_room (when transport was open) and broadcast roster left;
    // the close is just the transport tail.
    try {
      deps.closeSocket();
    } catch {
      // idempotent close
    }

    appendEvent({
      scope: "local",
      type: "future_phase_message",
      summary: "leave completed",
      detail: { kind: "mesh_leave_completed" },
    });
    deps.dispatch({ type: "MESH_LEAVE_COMPLETED" });

    running = false;
    done = true;
  }

  return {
    run,
    isRunning: () => running,
    hasRun: () => done,
  };
}
