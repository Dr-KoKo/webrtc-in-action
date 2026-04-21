// Import defineConfig from vitest/config so the `test` block type-checks
// against the Vitest-aware overload. The plain "vite" export rejects
// `test` because it's not part of the Vite user config schema.
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
  },
  test: {
    globals: true,
    environment: "jsdom",
    include: ["tests/**/*.{spec,test}.{ts,tsx}"],
  },
});
