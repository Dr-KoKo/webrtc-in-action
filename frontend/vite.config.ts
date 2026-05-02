// Import defineConfig from vitest/config so the `test` block type-checks
// against the Vitest-aware overload. The plain "vite" export rejects
// `test` because it's not part of the Vite user config schema.
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react(), basicSsl()],
  // Per-mode layout aliases (mirrors tsconfig.json paths). Vitest reads
  // this resolver, so test imports of "@/shared/..." resolve correctly.
  resolve: {
    alias: {
      "@/app":    fileURLToPath(new URL("./src/app", import.meta.url)),
      "@/modes":  fileURLToPath(new URL("./src/modes", import.meta.url)),
      "@/shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
    },
  },
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
  // `vite preview` (the prod image's runtime) is a separate server
  // from `vite dev` and does NOT honor `server.proxy`. Without its
  // own proxy block, `/ws` on the production image would 404 and the
  // same-origin fallback in JoinForm/FailurePanel would fail. Mirror
  // server.proxy here so prod and dev transports look identical from
  // the browser's perspective.
  preview: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
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
    // Per-mode layout: every mode owns its tests under
    // src/modes/<id>/tests/; shared specs colocate under src/shared/.
    include: [
      "src/modes/**/tests/**/*.{spec,test}.{ts,tsx}",
      "src/shared/**/*.{spec,test}.{ts,tsx}",
    ],
    // Playwright owns the browser layer. Vitest must not pick up
    // `tests/e2e/**` or it will try to run Playwright's `test()` in
    // a jsdom context and fail at import (`node:crypto`,
    // `@playwright/test` runner-only APIs).
    exclude: ["node_modules/**", "dist/**", "tests/e2e/**"],
  },
});
