// SignalingErrorBanner (M12 / T091, EC-012 / SC-005b / Path D).
//
// Surfaces a local-only banner when the mesh /ws/mesh transport drops
// while the local participant is admitted. The reducer transitions
// LocalParticipant.fsm → "signaling-error" on MESH_TRANSPORT_CHANGED
// with transport ∈ {"closed","error"} mid-session; this component
// observes that and renders.
//
// Hard boundaries (preserve honest WebRTC):
//   - NEVER auto-reconnects the WebSocket.
//   - NEVER closes RTCPeerConnections — existing pairs MAY keep
//     carrying media until natural ICE failure or user Leave.
//   - The Leave button stays available so the user can run Path A.
//
// Copy is fixed (matches quickstart): "Signaling connection lost.
// Other peers may see you as disconnected."

import { useMeshState } from "../state";

export const SIGNALING_ERROR_BANNER_COPY =
  "Signaling connection lost. Other peers may see you as disconnected.";

export function SignalingErrorBanner() {
  const { local } = useMeshState();
  if (local.fsm !== "signaling-error") return null;
  return (
    <section
      className="mesh-signaling-error-banner"
      role="alert"
      aria-live="assertive"
      data-testid="mesh-signaling-error-banner"
      data-fsm={local.fsm}
      data-transport={local.signalingTransport}
    >
      <p
        className="mesh-signaling-error-banner__copy"
        data-testid="mesh-signaling-error-banner-copy"
      >
        {SIGNALING_ERROR_BANNER_COPY}
      </p>
      {local.errorBanner?.detail ? (
        <p
          className="mesh-signaling-error-banner__detail"
          data-testid="mesh-signaling-error-banner-detail"
        >
          {local.errorBanner.detail}
        </p>
      ) : null}
      <p className="mesh-signaling-error-banner__hint">
        Existing media may continue briefly. Click <strong>Leave mesh</strong>{" "}
        to release your slot.
      </p>
    </section>
  );
}
