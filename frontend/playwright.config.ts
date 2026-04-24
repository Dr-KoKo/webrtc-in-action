// Playwright config for the Phase 6 e2e suite.
//
// Intentional choices:
// - No `webServer` block. The per-commit verify loop orchestrates
//   `docker compose up -d --build --force-recreate` outside Playwright
//   and gates both `:5173` and `:8080/healthz` with curl before
//   invoking `npx playwright test`. Playwright's single-URL
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
    baseURL: "http://localhost:5173",
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
