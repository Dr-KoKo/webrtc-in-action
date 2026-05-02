// PartialMeshBadge (M11 / T082, FR-065 / L15).
//
// Renders a small banner alongside the cost summary while the mesh is
// in a partial-failure window: at least ONE PairContext is `failed`
// AND at least ONE PairContext is `connected`. The badge MUST NOT
// imply whole-room failure — mesh has no room-level failed terminal
// state. The text intentionally names per-pair semantics (Spec FR-065
// + plan-prompt M11 boundary).
//
// Truth table (T082 DoD):
//   failedCount=0                        → not rendered
//   connectedCount=0 (no healthy pairs)  → not rendered
//   ≥1 failed AND ≥1 connected           → rendered
//
// Source-of-truth: derives state purely from `selectPairsAsArray`. No
// new global flag is introduced — the partial-mesh window is a derived
// view, not a stored room-level state (avoids Spec Non-Goals
// "room-global failed state").

import { useEffect, useRef } from "react";
import { useMeshState, useMeshDispatch } from "../state";
import { selectPairsAsArray } from "../state/pairs";
import { makeMeshEventEntry } from "../state/eventLog";

const BADGE_TEXT = "Partial mesh: some peer pairs failed";

export function PartialMeshBadge() {
  const { pairs } = useMeshState();
  const dispatch = useMeshDispatch();
  const all = selectPairsAsArray(pairs);
  const failed = all.filter((p) => p.connectionState === "failed").length;
  const connected = all.filter((p) => p.connectionState === "connected").length;
  const visible = failed > 0 && connected > 0;

  // Emit one-shot enter / clear events to the mesh log so a reader can
  // tell from the log when the partial-failure window started and
  // ended (FR-061 — every observable transition is event-logged).
  const wasVisibleRef = useRef(false);
  useEffect(() => {
    if (visible && !wasVisibleRef.current) {
      wasVisibleRef.current = true;
      dispatch({
        type: "MESH_EVENT_APPEND",
        entry: makeMeshEventEntry({
          scope: "room",
          type: "future_phase_message",
          summary: `partial mesh state entered (failed=${failed}, connected=${connected})`,
          detail: {
            kind: "partial_mesh_entered",
            failedPairCount: failed,
            connectedPairCount: connected,
          },
        }),
      });
    } else if (!visible && wasVisibleRef.current) {
      wasVisibleRef.current = false;
      dispatch({
        type: "MESH_EVENT_APPEND",
        entry: makeMeshEventEntry({
          scope: "room",
          type: "future_phase_message",
          summary: `partial mesh state cleared (failed=${failed}, connected=${connected})`,
          detail: {
            kind: "partial_mesh_cleared",
            failedPairCount: failed,
            connectedPairCount: connected,
          },
        }),
      });
    }
  }, [visible, failed, connected, dispatch]);

  if (!visible) {
    return (
      <div
        className="mesh-partial-badge mesh-partial-badge--hidden"
        data-testid="mesh-partial-mesh-badge"
        data-visible="false"
        aria-hidden="true"
      />
    );
  }
  return (
    <div
      className="mesh-partial-badge"
      data-testid="mesh-partial-mesh-badge"
      data-visible="true"
      data-failed-count={failed}
      data-connected-count={connected}
      role="status"
    >
      <span className="mesh-partial-badge__text">{BADGE_TEXT}</span>
      <span
        className="mesh-partial-badge__counts"
        data-testid="mesh-partial-mesh-badge-counts"
      >
        ({connected} connected · {failed} failed)
      </span>
    </div>
  );
}
