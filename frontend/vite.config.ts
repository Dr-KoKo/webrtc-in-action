// Import defineConfig from vitest/config so the `test` block type-checks
// against the Vitest-aware overload. The plain "vite" export rejects
// `test` because it's not part of the Vite user config schema.
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";

export default defineConfig({
  plugins: [react(), basicSsl()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    // Proxy the signaling WS through Vite so the browser can use the
    // same (HTTPS) origin as the page — required by secure-context APIs
    // like crypto.randomUUID and navigator.mediaDevices.getUserMedia.
    // Target uses the docker-compose service DNS; running outside
    // compose would need http://127.0.0.1:8080 instead.
    proxy: {
      "/ws": {
        target: "http://signaling:8080",
        ws: true,
        changeOrigin: true,
      },
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    include: ["tests/**/*.{spec,test}.{ts,tsx}"],
    // Playwright owns the browser layer. Vitest must not pick up
    // `tests/e2e/**` or it will try to run Playwright's `test()` in
    // a jsdom context and fail at import (`node:crypto`,
    // `@playwright/test` runner-only APIs).
    exclude: ["node_modules/**", "dist/**", "tests/e2e/**"],
  },
});
