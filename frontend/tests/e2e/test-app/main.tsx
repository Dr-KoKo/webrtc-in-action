// Test-only Vite entrypoint for the Phase 6 Playwright suite.
//
// This file is NEVER referenced from the production `index.html` at the
// project root and `vite.config.ts` carries no `rollupOptions.input`
// override, so `vite build` excludes it from `dist/`. It is served by
// `vite dev` at `/tests/e2e/test-app/index.html`, which Playwright
// scenarios open as the "app URL" for each browser context.
//
// Two intentional deviations from production `src/main.tsx`:
//
// 1. No `<StrictMode>` wrapper. React 18 StrictMode double-invokes the
//    initial mount effect cycle; under a first-fail-then-succeed
//    `getUserMedia` injection that would let the first (cancelled)
//    pass silently consume the scheduled failure, so `media-error` is
//    never reached and scenarios 3 + 4 break. Production keeps
//    StrictMode; the resulting coverage gap is documented in the plan.
//
// 2. `?media=…` query param on THIS entry selects a test-only
//    `acquireOptions.getUserMedia` closure. The closure is passed
//    through the provider's existing `acquireOptions` prop (a DI seam
//    shipped for production reasons, `local-media-provider.tsx:57-62`).
//    Nothing in `src/` reads the query param; only this file does.
//    Supported values:
//      - `real` (default) — omit the prop, use real
//        `navigator.mediaDevices.getUserMedia` with Chromium's
//        `--use-fake-device-for-media-stream`.
//      - `failOnce` — first call rejects with a synthesized
//        `NotAllowedError` DOMException; subsequent calls delegate to
//        the real fake-device pipeline. A counter in the closure
//        tracks call count; it survives a Retry click (no page
//        reload) and resets on full page reload.

import { createRoot } from "react-dom/client";
import { AppShell } from "../../../src/components/AppShell";
import { StoreProvider } from "../../../src/state";
import { SignalingProvider } from "../../../src/signaling/provider";
import { LocalMediaProvider } from "../../../src/webrtc/local-media-provider";
import { PeerConnectionProvider } from "../../../src/webrtc/peer-connection-provider";
import type { AcquireLocalMediaOptions } from "../../../src/webrtc/media-acquisition";

type MediaMode = "real" | "failOnce";

function resolveMediaMode(): MediaMode {
  const raw = new URLSearchParams(window.location.search).get("media");
  return raw === "failOnce" ? "failOnce" : "real";
}

function makeFailOnceAcquireOptions(): AcquireLocalMediaOptions {
  let calls = 0;
  return {
    getUserMedia: async (constraints) => {
      calls += 1;
      if (calls === 1) {
        throw new DOMException(
          "Permission denied (synthesized by e2e failOnce mode)",
          "NotAllowedError",
        );
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new DOMException(
          "navigator.mediaDevices.getUserMedia unavailable",
          "NotSupportedError",
        );
      }
      return navigator.mediaDevices.getUserMedia(constraints);
    },
  };
}

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("#root element missing from test-app index.html");
}

const mode = resolveMediaMode();
const acquireOptions =
  mode === "failOnce" ? makeFailOnceAcquireOptions() : undefined;

createRoot(rootElement).render(
  <StoreProvider>
    <SignalingProvider>
      <LocalMediaProvider
        {...(acquireOptions ? { acquireOptions } : {})}
      >
        <PeerConnectionProvider>
          <AppShell />
        </PeerConnectionProvider>
      </LocalMediaProvider>
    </SignalingProvider>
  </StoreProvider>,
);
