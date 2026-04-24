// Playwright config for the Phase 6 e2e suite.
//
// Intentional choices:
// - No `webServer` block. The per-commit verify loop orchestrates
//   `docker compose -f docker-compose.dev.yml up -d --build
//   --force-recreate` outside Playwright and gates both `:5173` and
//   `:8080/healthz` with curl before invoking `npx playwright test`.
//   The dev compose file is required (not the default prod one)
//   because Playwright hits `/tests/e2e/test-app/`, which only
//   Vite's dev server resolves on demand — the prod image bakes
//   `vite build` output, which excludes the test-app entry
//   (see vite.config.ts rollupOptions). Playwright's single-URL
//   `webServer.url` would miss the signaling readiness gate, and
//   `reuseExistingServer: true` would risk running tests against
//   stale container images baked from a previous commit (the dev
//   Dockerfiles `COPY . .`).
// - `workers: 1` + `fullyParallel: false` at four scenarios. Room-ID
//   collisions are already defended against by the `randomBytes`
//   suffix in `roomIdFor`; the single-worker choice is a
//   harness-simplicity call for Phase 6, not a correctness one.
// - Chromium only. Fake-device flags (`--use-fake-device-for-media-
//   stream`, `--use-fake-ui-for-media-stream`) auto-grant camera /
//   mic and inject a synthetic stream. `--autoplay-policy=no-user-
//   gesture-required` keeps the `<video autoPlay muted>` in
//   `LocalVideo.tsx` from being blocked.

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /.*\.spec\.ts$/,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    // Vite dev serves HTTPS via @vitejs/plugin-basic-ssl (commit
    // 87607e4) so getUserMedia works on non-localhost LAN hosts
    // without per-browser insecure-origin flags. The self-signed
    // cert requires `ignoreHTTPSErrors` — Chromium would otherwise
    // fail the initial `page.goto` with `net::ERR_CERT_AUTHORITY_
    // INVALID`. Plain `http://localhost:5173` returns
    // `net::ERR_EMPTY_RESPONSE` because Vite only answers HTTPS.
    baseURL: "https://localhost:5173",
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
    video: "off",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        launchOptions: {
          args: [
            "--use-fake-device-for-media-stream",
            "--use-fake-ui-for-media-stream",
            "--autoplay-policy=no-user-gesture-required",
          ],
        },
      },
    },
  ],
});
