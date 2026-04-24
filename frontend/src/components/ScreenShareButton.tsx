// ScreenShareButton — Phase 11 (T076, FR-014a, FR-017, SC-007),
// Phase 12 refactored to consume `<ScreenShareProvider>`.
//
// One button that flips between "Share screen" and "Stop sharing"
// based on the current local screen-share triplet value. Disabled
// whenever `session.session !== "connected"` OR the signaling
// transport has dropped (error state) — per §B.1.1, screen-share
// renegotiation is gated off while the WS is down so the remote never
// observes a stale triplet.
//
// The controller + its hooks live in `ScreenShareProvider` so the
// Phase-12 cleanup orchestrator (`useCleanup` in `webrtc/cleanup.ts`)
// can call `stop("app")` on the same instance BEFORE the PC is closed
// on Path A / Path C. The button's click handler stays a thin wrapper
// over `controller.start()` / `controller.stop("app")`.

import { useCallback } from "react";
import { useRootState } from "../state";
import { useScreenShare } from "../webrtc/screen-share-provider";

export function ScreenShareButton() {
  const { media, session } = useRootState();
  const { isActive, start, stop } = useScreenShare();

  const active = media.local.screenShare === "active";
  const disabled =
    session.session !== "connected" || session.transport === "error";

  const onClick = useCallback(() => {
    void (async () => {
      if (isActive()) {
        await stop("app");
      } else {
        await start();
      }
    })();
  }, [isActive, start, stop]);

  return (
    <section
      aria-labelledby="screen-share-heading"
      className="screen-share"
    >
      <h2 id="screen-share-heading">Screen share</h2>
      <button
        type="button"
        data-testid="screen-share-toggle"
        aria-pressed={active}
        disabled={disabled}
        onClick={onClick}
      >
        {active ? "Stop sharing" : "Share screen"}
      </button>
    </section>
  );
}
