# Architecture: per-mode layout

**Status**: canonical. **Date**: 2026-04-27.
**Scope**: cross-version structure rules. Per-version specs (001, 002, …) remain authoritative for their own contracts and behavior.

This repo is a learning playground for multiple WebRTC topologies. Every WebRTC implementation is a self-contained **mode**:

| id           | UI label                  | Route                | Signaling endpoint | Spec                          |
|--------------|---------------------------|----------------------|--------------------|-------------------------------|
| `one-to-one` | 1:1 mode                  | `/`                  | `/ws`              | `specs/001-webrtc-1to1-call/` |
| `mesh`       | Mesh mode (capacity 4)    | `/mesh/:roomId`      | `/ws/mesh`         | `specs/002-webrtc-mesh-room/` |

Future modes (SFU, recording, simulcast, …) follow the same pattern.

## Boundary rules (apply forever)

1. A **mode** may import **shared**.
2. **shared** must NEVER import a mode.
3. One mode must NEVER import another mode.
4. Contract schemas, reducers, presence states, pair states, room-capacity rules, negotiation rules — **mode-owned**.
5. Only stable infrastructure goes in **shared**: heartbeat, ICE config loading, logging, generic media-acquisition helper, structurally-shared primitive types.
6. **No generic "WebRTC topology engine."** 1:1, mesh, and SFU have materially different state machines; a fake abstraction makes the code less educational and harder to debug.
7. **Cross-tree imports MUST go through TS path aliases (`@/...`) / Go module paths (`webrtc-lab/signaling/internal/...`)** — relative imports must not escape a mode subdir or `shared/`.

Rules 1–3 and 7 are enforced at validation time by `scripts/audit-boundaries.sh`. The mode list is enumerated inline in two `for m in ...` loops (frontend + backend); adding a mode requires updating both.

## Repo shape

### Frontend (`frontend/src/`)

```
app/
  main.tsx          — Vite entry
  App.tsx           — <BrowserRouter> + <ModeBadge> + <AppRoutes>
  routes.tsx        — iterates MODES + wildcard fallback
  ModeBadge.tsx     — uses matchPath() against MODES, falls back to FALLBACK_MODE_ID
  modes.tsx         — single source of truth: { id, label, path, component, signalingPath }
shared/
  contract/         — primitive types both modes share (e.g. MediaFailedReason)
  webrtc/           — pure helpers (e.g. acquireLocalMedia)
modes/
  one-to-one/
    route/OneToOneApp.tsx
    components/  state/  signaling/  webrtc/  types/  tests/
  mesh/
    route/MeshApp.tsx
    components/  state/  signaling/  webrtc/  tests/

tests/
  e2e/              — Playwright cross-mode browser scenarios
```

TypeScript path aliases (`tsconfig.json` `paths` + `vite.config.ts` `resolve.alias`):

| Alias        | Maps to        |
|--------------|----------------|
| `@/app/*`    | `src/app/*`    |
| `@/modes/*`  | `src/modes/*`  |
| `@/shared/*` | `src/shared/*` |

### Backend (`signaling/`)

```
cmd/signaling/main.go        — minimal entry; calls app.RegisterRoutes(...)
internal/
  app/
    routes.go                — mux wiring per mode + /healthz
  shared/
    heartbeat/               — parameterized over Labels{ PongTimeoutEvent, PongTimeoutMessage }
    config/                  — IceServer + LoadFromEnv (tag-less internal struct)
    logging/                 — slog setup
  modes/
    onetoone/
      handler.go  envelope.go  messages.go  heartbeat.go
      room/                  — manager.go  room.go  state.go
    mesh/
      handler.go  protocol*.go  manager.go  room.go  participant.go  pair.go  roster.go  heartbeat.go

tests/
  modes/
    onetoone/                — 001 protocol-flow + room manager + messages + heartbeat tests
    mesh/                    — mesh handler + admission + roster + media-failed tests
  shared/
    heartbeat_test.go        — locks observable-log behavior of the parameterized helper
```

## Adding a new mode

Suppose we add `sfu` (Selective Forwarding Unit, contract v3):

1. **Spec**: write `specs/003-webrtc-sfu/{spec,plan,contracts/...}.md`.
2. **Frontend**:
   - Create `frontend/src/modes/sfu/` mirroring the mesh subtree.
   - Add an entry to `frontend/src/app/modes.tsx`:
     ```ts
     { id: "sfu", label: "SFU mode", path: "/sfu/:roomId", component: SfuApp, signalingPath: "/ws/sfu" }
     ```
3. **Backend**:
   - Create `signaling/internal/modes/sfu/` with the handler + protocol files. The `handler.go` is a `wsserver.Mode` adapter — see `signaling/internal/modes/{onetoone,mesh}/handler.go` as templates: a `Handler` struct holding the room manager + ICE config, `NewHandler` returning `*Handler` and constructing a private `*wsserver.Server`, `ServeHTTP` delegating to it, and a per-WS struct (e.g. `sfuConn`) implementing `wsserver.SessionHandler` (and the mode's own `Conn` interface if the room manager broadcasts to it).
   - Wire `mux.Handle("/ws/sfu", sfu.NewHandler(...))` inside `internal/app/routes.go`.
4. **Tests**: `signaling/tests/modes/sfu/` for Go protocol-flow tests; `frontend/src/modes/sfu/tests/` for Vitest reducer / dispatcher specs.
5. **Boundary audit**: append `sfu` to the `FRONT_MODES` and `BACK_MODES` arrays in `scripts/audit-boundaries.sh`. Without this, cross-mode-imports involving `sfu` would slip past the gate.
6. **Architecture doc**: append a row to the table at the top of this file.
7. **Validation**: `npm run typecheck && npx vitest run && go test ./... && bash scripts/audit-boundaries.sh`.

The boundary audit is heuristic-by-design (regex over imports + `go list -deps`). The mode list inside the script is hand-maintained — that's the documented maintenance cost of the per-mode pattern.

## What lives in `shared/` vs. mode-owned

**In `shared/` today:**

- Frontend `shared/contract/media-failed-reason.ts` — the 4-element `MediaFailedReason` enum (both contracts agree).
- Frontend `shared/webrtc/media-acquisition.ts` — `getUserMedia` wrapper + DOMException → `MediaFailedReason` classifier.
- Backend `internal/shared/logging/` — slog setup.
- Backend `internal/shared/heartbeat/` (Commit B) — parameterized over `Labels` so each mode keeps its event-name + message text.
- Backend `internal/shared/config/` (Commit B) — tag-less `IceServer` + `LoadFromEnv()`.
- Backend `internal/shared/wsserver/` — WebSocket session lifecycle (Accept, conn-id, heartbeat goroutine launch, write serialization, read loop, error classification, teardown ordering). Identical across modes; lifted so each mode's `handler.go` opens with topology (admission, roster, dispatch) instead of ~100 lines of WebSocket bookkeeping. Modes implement `wsserver.Mode.NewSession` returning a `wsserver.SessionHandler`. Mode-specific decode/dispatch error log fields (`code`, `type`) stay on the mode side.

**Explicitly NOT in `shared/`** (kept mode-owned because abstracting hurts more than it helps):

- The signaling-protocol Zod schemas (v1, v2). Different discriminated unions; sharing requires generics over the union, which obscures rather than clarifies.
- Reducers + state slices (`session`, `roster`, `eventLog`, `chat`). Entry shapes differ; merging requires schema reconciliation that hides per-mode invariants.
- `IceBuffer`. 001 uses a single per-call buffer; mesh M6+ uses per-`PairContext` buffers. Different shapes.
- WebSocket-client base. Schema typing differs; a generic base obscures the per-mode contract.
- Wire-payload `IceServer` types. Each mode keeps JSON-tagged structs; the shared `config.IceServer` is the internal config representation, with explicit conversion at the wire boundary.

Lift any of these only when a third mode arrives and the duplication is genuinely costly. Resist preemptive abstraction (Constitution Principle IX).

## References

- Constitution: `.specify/memory/constitution.md` (Principle IX preserves extension points; this doc realizes them).
- 001 plan + contract: `specs/001-webrtc-1to1-call/`.
- 002 plan + contract: `specs/002-webrtc-mesh-room/`.
- Boundary audit script: `scripts/audit-boundaries.sh`.
