# Phase 13 production-ish frontend image (multi-stage).
#
# Scope (plan §Phase 13 + §Non-Goals): this is a local-dev packaging
# target, not a cloud-deploy artifact. The MVP has no production
# deployment story (spec Non-Goals); "production" here means "not
# vite dev".
#
# Runtime choice: `vite preview` on node:22-alpine.
#   - Why not nginx:alpine? HTTPS on :5173 is generated at server
#     start by @vitejs/plugin-basic-ssl. Replacing the runtime with
#     nginx would force us to bake a hand-rolled self-signed cert and
#     maintain a second cert path, duplicating the plugin's job.
#   - Tradeoff: image is ~node+node_modules sized instead of ~5 MB
#     nginx. Acceptable for a learning tool on localhost; see spec
#     Non-Goals (no cloud deploy, no prod monitoring).
#
# HTTPS story: @vitejs/plugin-basic-ssl registers `configurePreviewServer`
# in addition to the dev server, so `vite preview` serves the same
# self-signed cert at `https://<host>:5173/`. Browsers will warn — see
# quickstart §7 for bypass instructions. LAN access works by passing
# --host 0.0.0.0 below.
#
# Playwright / e2e reproducibility: the Phase-12 playwright flow hits
# `https://localhost:5173/tests/e2e/test-app/index.html`. That entry
# lives at `frontend/tests/e2e/test-app/` and is NOT listed in
# `rollupOptions.input` (see vite.config.ts — deliberately dev-only).
# This prod image therefore serves only the user app at `/`. Playwright
# continues to run against the DEV image (Dockerfile.dev) via compose
# or `npm run dev`. See README.md §"Run tests".

# -----------------------------------------------------------------
# Stage 1 — build: produce static assets in /app/dist via `vite build`.
# -----------------------------------------------------------------
FROM node:22-alpine AS build

WORKDIR /app

# Deterministic install from lockfile. `--no-audit --no-fund` keeps
# build logs focused on what's actually happening.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Copy the source tree AFTER install so lockfile changes alone
# re-trigger the install layer. `.dockerignore` (repo root) trims
# tests/, node_modules/, dist/, etc. from the context.
COPY . .

RUN npm run build

# -----------------------------------------------------------------
# Stage 2 — runtime: `vite preview` serving /app/dist over HTTPS.
# -----------------------------------------------------------------
# We copy node_modules (not re-install) so no new deps sneak in and
# the runtime matches what the build verified. The vite package is
# a devDependency — pruning with `npm prune --production` would
# strip it, so we keep the install tree as-is. Spec Non-Goals rules
# out prod image optimization beyond "runs locally".
FROM node:22-alpine AS runtime

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/vite.config.ts ./vite.config.ts
COPY --from=build /app/index.html ./index.html

EXPOSE 5173

# `vite preview`:
#   --host 0.0.0.0  → bind all interfaces (LAN access from a second
#                     machine for NFR-001 secure-context parity).
#   --port 5173     → override preview's 4173 default so compose,
#                     quickstart, and Playwright keep the same URL.
#   --strictPort    → fail fast if 5173 is taken; matches vite.config.ts.
# HTTPS is applied by @vitejs/plugin-basic-ssl's configurePreviewServer
# hook — no extra flag is needed here. See vite.config.ts.
CMD ["npx", "vite", "preview", "--host", "0.0.0.0", "--port", "5173", "--strictPort"]
