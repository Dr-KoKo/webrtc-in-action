# webrtc-lab — 1:1 WebRTC Learning Call

A two-package learning application that establishes a 1:1 WebRTC call
(audio + video + chat + screen share) with the **full connection
lifecycle visible in the UI**. The frontend is React + TypeScript + Vite
calling the browser WebRTC APIs directly (no wrappers). The signaling
server is a small Go + WebSocket service that **only** routes signaling
messages — it never touches media.

**Active feature**: `001-webrtc-1to1-call` (branch
`001-webrtc-1to1-call`).

## Packages

- [`frontend/`](./frontend) — React 18 + TypeScript + Vite client.
- [`signaling/`](./signaling) — Go 1.23+ WebSocket signaling server.
- [`infra/coturn/`](./infra/coturn) — optional coturn config (opt-in).
- [`docker-compose.yml`](./docker-compose.yml) — one-command local bring-up.

## Spec-kit artifacts (single source of truth)

The feature is specified and planned in detail under
[`specs/001-webrtc-1to1-call/`](./specs/001-webrtc-1to1-call):

- [Feature spec](./specs/001-webrtc-1to1-call/spec.md)
- [Implementation plan](./specs/001-webrtc-1to1-call/plan.md)
- [Phase 0 research](./specs/001-webrtc-1to1-call/research.md)
- [Phase 1 data model](./specs/001-webrtc-1to1-call/data-model.md)
- [Phase 1 signaling contract (canonical)](./specs/001-webrtc-1to1-call/contracts/signaling-protocol.md)
- [Phase 1 quickstart + manual verification checklist](./specs/001-webrtc-1to1-call/quickstart.md)
- [Phase 2 tasks list](./specs/001-webrtc-1to1-call/tasks.md)

The project governance document is
[`.specify/memory/constitution.md`](./.specify/memory/constitution.md)
(v2.0.0).

## Quick start (once later phases are implemented)

```sh
cp .env.example .env
docker compose up
```

Open two browser tabs at `http://localhost:5173/` and join the same
room ID. See
[`specs/001-webrtc-1to1-call/quickstart.md`](./specs/001-webrtc-1to1-call/quickstart.md)
for the full manual verification procedure.
