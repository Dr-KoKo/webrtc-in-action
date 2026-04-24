# webrtc-lab — 1:1 WebRTC Learning Call

A two-package learning application that establishes a 1:1 WebRTC call
(audio + video + chat + screen share) with the **full connection
lifecycle visible in the UI**. The frontend is React + TypeScript + Vite
calling the browser WebRTC APIs directly (no wrappers); the signaling
server is a small Go + WebSocket service that **only** routes signaling
JSON — it never touches media. Full spec:
[`specs/001-webrtc-1to1-call/spec.md`](./specs/001-webrtc-1to1-call/spec.md).

The MVP is **local-dev only** — there is no cloud deploy, no managed
TURN, no auth, no persistence (spec Non-Goals). The app uses a browser-
generated self-signed cert for HTTPS on `:5173`; browsers will warn, and
the warning is expected.

---

## Quick start

No host Node, no host Go, no extra setup — just Docker Compose v2.

```bash
cp .env.example .env
docker compose up --build
```

This builds the production-ish images (distroless Go signaling server +
`vite preview` serving the built `dist/`) and brings both services up.
Signaling passes its `/healthz` before the frontend boots (compose
`depends_on: service_healthy`).

Then open **two separate browser windows or profiles** at:

```
https://localhost:5173/
```

Both windows will show a self-signed-certificate warning. That is
expected — the cert is generated at build time by
`@vitejs/plugin-basic-ssl`, only for local dev. Bypass per browser (see
[quickstart.md §7](./specs/001-webrtc-1to1-call/quickstart.md#7-cross-browser-notes)):

| Browser | Bypass |
|---|---|
| Chromium (Chrome / Edge / Arc) | Click **Advanced → Proceed to localhost (unsafe)** |
| Firefox | **Advanced → Accept the Risk and Continue** |
| Safari | **Show Details → visit this website → Visit Website** |

Enter the same room ID in both windows and click **Join**. For the full
happy-path walkthrough, see
[quickstart.md §4](./specs/001-webrtc-1to1-call/quickstart.md#4-walk-the-happy-path).

Clean shutdown:

```bash
docker compose down
```

---

## Enable TURN (optional)

TURN is OFF by default — the localhost flow works peer-to-peer without
it. To exercise the TURN-relay learning outcome (spec FR-012):

1. Uncomment the `coturn` service block in
   [`docker-compose.yml`](./docker-compose.yml).
2. Copy `.env.example` to `.env` and fill in the four TURN variables
   plus `TURN_USERNAME` / `TURN_PASSWORD` (values must match).
3. `docker compose up --build`.

Verification walkthrough:
[quickstart.md §6](./specs/001-webrtc-1to1-call/quickstart.md#6-optional-enable-coturn-turn-relay).
The Learning Inspector panel should report `TURN configured: yes` and,
under UDP-blocked conditions, `relay candidate present: yes`.

Credentials are env-sourced — the example config
([`infra/coturn/turnserver.conf.example`](./infra/coturn/turnserver.conf.example))
contains no secrets. Rotate any placeholder string before any
non-localhost use (NFR-002 / NFR-005).

---

## Run tests

**Frontend unit tests** (Vitest + React Testing Library):

```bash
cd frontend
npx vitest run
npx tsc --noEmit          # type check
```

**Frontend end-to-end tests** (Playwright, Chromium-only). Playwright
hits `https://localhost:5173/tests/e2e/test-app/…`, which only Vite's
dev server resolves. Use the **dev** compose file (not the default prod
one), then run the suite:

```bash
cp .env.dev.example .env.dev
docker compose -f docker-compose.dev.yml --env-file .env.dev up -d --build --force-recreate
cd frontend
npx playwright test
```

**Signaling tests** (Go stdlib testing + testify):

```bash
cd signaling
go test ./...
```

See [`frontend/tests/e2e/COVERAGE.md`](./frontend/tests/e2e/COVERAGE.md)
for the Playwright scenario → spec-ID matrix.

---

## Directory layout

- [`frontend/`](./frontend) — React 18 + TypeScript + Vite client. Multi-
  stage prod image (`Dockerfile`) serves the built SPA via `vite preview`;
  dev image (`Dockerfile.dev`) runs `vite dev` for fast iteration + e2e.
- [`signaling/`](./signaling) — Go 1.23+ WebSocket signaling server.
  Prod image is a distroless/static-debian12:nonroot binary; dev image
  (`Dockerfile.dev`) builds and runs from source. Ships an auxiliary
  `cmd/healthprobe` binary that the compose healthcheck invokes
  (distroless has no shell / wget / curl).
- [`infra/coturn/`](./infra/coturn) — example TURN relay config. Disabled
  by default.
- [`specs/001-webrtc-1to1-call/`](./specs/001-webrtc-1to1-call) — feature
  spec, implementation plan, phase 0/1 artifacts, signaling protocol
  contract, quickstart + manual verification checklist, and the 14-phase
  task list.
- [`docs/manual-tests/`](./docs/manual-tests) — human-run test scripts
  (two-browser walkthrough, screen-share edge cases).

The two compose files are:

- [`docker-compose.yml`](./docker-compose.yml) — default, used by
  `docker compose up --build`. Production-ish bring-up (distroless
  signaling, `vite preview` frontend, healthcheck-gated startup).
- [`docker-compose.dev.yml`](./docker-compose.dev.yml) — opt-in, used
  by `docker compose -f docker-compose.dev.yml --env-file .env.dev up --build`.
  Dev Dockerfiles, Vite dev server (serves the Playwright test-app on
  demand), no healthcheck.

---

## Full docs

- [Feature spec](./specs/001-webrtc-1to1-call/spec.md) — requirements,
  Non-Goals, NFRs, success criteria.
- [Implementation plan](./specs/001-webrtc-1to1-call/plan.md) — 14-phase
  slice plan, architecture diagrams, risk register.
- [Signaling protocol contract](./specs/001-webrtc-1to1-call/contracts/signaling-protocol.md)
  — canonical message types and state transitions.
- [Quickstart + manual verification](./specs/001-webrtc-1to1-call/quickstart.md)
  — the detailed two-browser walkthrough, failure-path tests, and
  per-phase Definition-of-Done checklist.
- [Project constitution v2.0.0](./.specify/memory/constitution.md) —
  nine project principles (specification-first, contract-first signaling,
  separate signaling from media transport, vertical slices, lifecycle
  visibility, failure-aware design, security-by-default, testing
  discipline, simplicity with extension points).
