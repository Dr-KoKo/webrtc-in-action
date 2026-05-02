// MediaErrorBanner (T044). Persistent banner shown when the local
// participant is in `media-error` (post-admission media acquisition
// failed). Offers a Retry button that re-runs `getUserMedia` without
// a full page reload (data-model §B.1, contract §3.7 / §3.8).
//
// `released` (server-side slot release) keeps the banner visible — the
// user can still click Retry to re-attempt, but the room slot has
// already been freed; the user must re-join. The reducer disposes of
// the `peerId` / `admissionIndex` on `MESH_LOCAL_RESET`, which is the
// natural follow-up to a Retry click after `released`.

import { useMeshDispatch, useMeshState } from "../state";
import { makeMeshEventEntry } from "../state/eventLog";

export function MediaErrorBanner() {
  const { local } = useMeshState();
  const dispatch = useMeshDispatch();
  const visible =
    local.fsm === "media-error" || local.fsm === "released";
  if (!visible) return null;
  const isReleased = local.fsm === "released";

  function handleRetry() {
    if (local.fsm === "media-error") {
      // The reducer transitions `media-error → joined` on this action;
      // the media controller's `joined`-driven effect picks up the
      // next attempt automatically.
      dispatch({ type: "MESH_RETRY_REQUESTED" });
      dispatch({
        type: "MESH_EVENT_APPEND",
        entry: makeMeshEventEntry({
          scope: "local",
          type: "retry_requested",
          summary: "user clicked Retry on media-error banner",
        }),
      });
    } else {
      // released — slot is gone server-side; reset to idle so the
      // JoinForm re-arms.
      dispatch({ type: "MESH_LOCAL_RESET" });
    }
  }

  return (
    <div
      role="alert"
      className="mesh-media-error-banner"
      data-testid="mesh-media-error-banner"
      data-released={isReleased ? "true" : "false"}
    >
      <strong>
        {isReleased
          ? "Camera or microphone permission denied — your slot was released."
          : "Camera or microphone unavailable."}
      </strong>
      <p>
        {local.errorBanner?.detail ??
          "Grant camera + microphone permission and click Retry."}
      </p>
      <button
        type="button"
        onClick={handleRetry}
        data-testid="mesh-media-retry-button"
      >
        {isReleased ? "Return to lobby" : "Retry"}
      </button>
    </div>
  );
}
