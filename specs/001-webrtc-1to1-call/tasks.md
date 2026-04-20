---
description: "Implementation task list for 001-webrtc-1to1-call"
---

# Tasks: 1:1 WebRTC Learning Call

**Feature**: 1:1 WebRTC Learning Call (`001-webrtc-1to1-call`)
**Inputs** (authoritative, in priority order):

1. [`spec.md`](./spec.md)
2. [`plan.md`](./plan.md)
3. [`data-model.md`](./data-model.md)
4. [`contracts/signaling-protocol.md`](./contracts/signaling-protocol.md)
5. [`research.md`](./research.md)
6. [`quickstart.md`](./quickstart.md)

**Organization**: Tasks are grouped by the **implementation phases** defined
in `plan.md` (extended with a Phase 0 for repo/doc foundation, matching the
`/speckit.tasks` prompt). Every phase produces a runnable or verifiable
outcome; no phase crosses concerns that belong to another phase.

## Format

Each task has two parts:

1. A one-line checklist entry in the format
   `- [ ] T### [P?] short description — path(s)` for progress tracking.
2. A detail block listing **Phase / Purpose / Files / Dependencies /
   Parallelizable / Definition of Done / Verification**.

**Legend**:

- `[P]` — may be executed in parallel with other `[P]` tasks in the same
  phase because it touches different files and has no dependency on an
  in-flight task.
- Dependencies reference task IDs; `—` means no intra-feature dependency.

## Canonical signaling messages (do **not** invent new ones)

Only the 15 message types in
[`contracts/signaling-protocol.md`](./contracts/signaling-protocol.md) §3
are permitted. In particular:

- `room_full` is **not** a message type. Room-full rejection is
  `join_rejected.payload.result = "join_rejected_room_full"`.
- `peer_joined` and `peer_state_changed` are **not** message types. Use
  `peer_presence_changed` for every presence / readiness / release
  transition.
- `participant_released_media_failed` is **not** a message type — it is a
  `participant_released.payload.result` value.
- `peer_left` is a narrow convenience cleanup trigger emitted **only**
  when the departing peer had reached
  `callPhase ∈ {role-assigned, negotiating, connected}`. Pending-media
  releases use `peer_presence_changed(presence: "released")` alone.
- End-of-candidates for ICE MUST be `ice_candidate.payload.candidate =
  null` (the empty-string form is `malformed`).
- `media_ready.payload.mediaCapabilities` MUST set **both** `audio: true`
  and `video: true` (MVP does not support audio-only / video-only).

---

## Phase 0 — Repository and documentation foundation

**Goal**: every contributor can clone the repo, read a top-level README
that links to the spec-kit artifacts, and see the directory skeleton the
plan §Project Structure prescribes. No runtime yet.

- [ ] T001 Create root `README.md` with feature intro + spec-kit links — `README.md`
- [ ] T002 [P] Create directory skeleton for `frontend/`, `signaling/`, `infra/coturn/` — directories only
- [ ] T003 [P] Create `.gitignore` covering Node/Vite/Go/Docker artifacts — `.gitignore`
- [ ] T004 Scaffold `frontend/` package (Vite + React 18 + TS strict) — `frontend/package.json`, `frontend/tsconfig.json`, `frontend/vite.config.ts`, `frontend/index.html`, `frontend/src/main.tsx`, `frontend/src/App.tsx`
- [ ] T005 [P] Scaffold `signaling/` Go module (`go.mod`, empty `cmd/signaling/main.go`) — `signaling/go.mod`, `signaling/cmd/signaling/main.go`
- [ ] T006 Create baseline `docker-compose.yml` declaring `frontend` + `signaling` services (build contexts only; detailed env wiring lands in Phase 13) — `docker-compose.yml`
- [ ] T007 [P] Create `.env.example` enumerating every config variable (`VITE_STUN_URLS`, `VITE_TURN_URL`, `VITE_TURN_USERNAME`, `VITE_TURN_CREDENTIAL`, `LOG_FORMAT`, `PING_INTERVAL_MS`, `PONG_TIMEOUT_MS`, ports) — `.env.example`

### T001
- **Phase**: 0 — Repository and documentation foundation
- **Purpose**: Give every reader a single landing page that points at
  the spec-kit artifacts (spec, plan, data-model, contract, research,
  quickstart, constitution).
- **Files likely affected**: `README.md`.
- **Dependencies**: —
- **Parallelizable**: no (root README is the hub other tasks link to).
- **Definition of Done**: `README.md` exists at repo root; contains
  relative links to all six artifacts listed above and to the
  constitution; names `001-webrtc-1to1-call` as the active feature.
- **Verification**: open `README.md`, click every link, confirm none is
  broken.

### T002
- **Phase**: 0
- **Purpose**: Materialize the directory layout that plan.md
  §Project Structure assumes, so later tasks can drop files in
  without ambiguity.
- **Files likely affected**: `frontend/src/state/`, `frontend/src/webrtc/`,
  `frontend/src/signaling/`, `frontend/src/components/`, `frontend/src/types/`,
  `frontend/tests/unit/`, `frontend/tests/contract/`,
  `signaling/cmd/signaling/`, `signaling/internal/room/`,
  `signaling/internal/signaling/`, `signaling/internal/logging/`,
  `signaling/tests/`, `infra/coturn/`.
- **Dependencies**: —
- **Parallelizable**: yes — pure directory creation.
- **Definition of Done**: all directories above exist (with `.gitkeep`
  where empty).
- **Verification**: `git ls-files` lists the expected placeholders.

### T003
- **Phase**: 0
- **Purpose**: Prevent build output and secrets from being committed.
- **Files likely affected**: `.gitignore`.
- **Dependencies**: —
- **Parallelizable**: yes.
- **Definition of Done**: `.gitignore` ignores `node_modules/`,
  `dist/`, `build/`, `frontend/coverage/`, `.env`, `.env.local`,
  `*.log`, Go build artifacts, VS Code `.vscode/*` (except
  `settings.json` if you want), and Docker local volumes.
- **Verification**: `git status` in a fresh `docker compose build` run
  shows no untracked junk.

### T004
- **Phase**: 0
- **Purpose**: Give `frontend/` a minimal runnable scaffold so later
  phases can add React code without re-bootstrapping.
- **Files likely affected**: `frontend/package.json`,
  `frontend/tsconfig.json`, `frontend/vite.config.ts`,
  `frontend/index.html`, `frontend/src/main.tsx`,
  `frontend/src/App.tsx`.
- **Dependencies**: T002.
- **Parallelizable**: no (later Phase 0 tasks build on this).
- **Definition of Done**: `tsconfig.json` has `"strict": true`;
  dependencies exactly match plan.md Technical Context (`react`,
  `react-dom`, `vite`, `zod`, `vitest`, `@testing-library/react`, types
  for React); `App.tsx` renders a placeholder heading.
- **Verification**: `cd frontend && npm install && npm run dev`
  serves `http://localhost:5173/` showing the placeholder heading.

### T005
- **Phase**: 0
- **Purpose**: Give the Go signaling package a minimal module so Phase 1
  (contract) and Phase 2 (server) can drop in code.
- **Files likely affected**: `signaling/go.mod`,
  `signaling/cmd/signaling/main.go` (placeholder `main()` that
  `println("signaling placeholder")`).
- **Dependencies**: T002.
- **Parallelizable**: yes (independent from T004).
- **Definition of Done**: module name is `github.com/<org>/webrtc-lab/signaling`
  (or `webrtc-lab/signaling` if no org prefix chosen); Go version
  ≥ `1.22`; `go build ./...` succeeds.
- **Verification**: `cd signaling && go build ./...` exits 0.

### T006
- **Phase**: 0
- **Purpose**: One-command bring-up of both packages (even as empty
  placeholders) so Phase 1 contributors do not have to invent compose
  wiring.
- **Files likely affected**: `docker-compose.yml`, plus minimal
  `frontend/Dockerfile.dev` and `signaling/Dockerfile.dev` if needed
  (full images land in Phase 13 T083/T084).
- **Dependencies**: T004, T005.
- **Parallelizable**: no (edits `docker-compose.yml` which T007 does
  NOT touch but later phases do).
- **Definition of Done**: `docker compose config` parses; both services
  declared with `build:` contexts `./frontend` and `./signaling`;
  ports `5173` and `8080` published; named `frontend` and `signaling`.
  (Long-running + `/healthz` probe land in Phase 2 T015; the Phase 0
  placeholder `main()` from T005 may exit immediately.)
- **Verification**: `docker compose config` exits 0; `docker compose
  build` completes for both services. **Not** `docker compose up` —
  the Phase 0 Go placeholder exits as soon as `main()` returns.

### T007
- **Phase**: 0
- **Purpose**: Give every env var the system reads a documented,
  harmless default so a fresh clone boots on localhost with public
  STUN and no secrets.
- **Files likely affected**: `.env.example`.
- **Dependencies**: —
- **Parallelizable**: yes.
- **Definition of Done**: contains **every** env var that will be
  consumed in Phases 2, 4, 12, 13 (`VITE_STUN_URLS`,
  `VITE_TURN_URL`, `VITE_TURN_USERNAME`, `VITE_TURN_CREDENTIAL`,
  `LOG_FORMAT`, `PING_INTERVAL_MS`, `PONG_TIMEOUT_MS`,
  `FRONTEND_PORT`, `SIGNALING_PORT`); no real secrets; TURN block is
  commented out by default.
- **Verification**: grep the future codebase for `process.env` /
  `os.Getenv` — every var found is present in `.env.example`.

**Phase 0 exit criterion**: `docker compose config` + `docker compose
build` succeed for both services; the directory skeleton from plan.md
§Project Structure exists; `README.md` links to the six spec-kit
artifacts. **A long-running signaling server + `/healthz` are NOT
Phase 0 goals** — those land in Phase 2 (T015). The Phase 0 Go
placeholder is allowed to exit immediately.

---

## Phase 1 — Signaling contract foundation

**Goal**: both sides of the wire share a single, tested schema for
**every** envelope field and **every** message type in
`contracts/signaling-protocol.md` v1. No server logic and no UI is
written against the contract until this phase is green.

- [ ] T008 Implement Zod envelope schema + shared primitives (`v`, `type`, `roomId`, `from`, `to`, `requestId`, `ts`) — `frontend/src/signaling/schema.ts`
- [ ] T009 Implement Zod per-message schemas for all 15 types from contract §3 — `frontend/src/signaling/schema.ts`
- [ ] T010 [P] Derive TS contract types from Zod inference (`z.infer<typeof …>` exports) — `frontend/src/types/contract.ts`
- [ ] T011 [P] Frontend schema validation tests (envelope, room ID, chat, each message, direction asymmetries) — `frontend/tests/unit/schema.spec.ts`
- [ ] T012 Implement Go envelope struct + dispatch helpers — `signaling/internal/signaling/envelope.go`
- [ ] T013 Implement Go per-message structs + `Validate()` for all 15 types — `signaling/internal/signaling/messages.go`
- [ ] T014 [P] Go contract tests (marshal, unmarshal, validator reject paths) — `signaling/tests/messages_test.go`

### T008
- **Phase**: 1 — Signaling contract foundation
- **Purpose**: Define the envelope schema (with required / optional field
  rules from contract §1) once, reused by every per-message schema.
- **Files**: `frontend/src/signaling/schema.ts`.
- **Dependencies**: T004.
- **Parallelizable**: no (T009 extends the same file).
- **Definition of Done**: Zod schemas for `v === 1`, `type` enum, room
  ID regex `^[A-Za-z0-9._-]{1,64}$`, UUIDv4 (`peerId`, `requestId`),
  `ts` integer, optional `from` / `to`, plus exported message direction
  discriminator types per contract §2.
- **Verification**: `npm run typecheck` passes; Vitest parses a
  known-good envelope and rejects `v: 2`, bad room IDs, and malformed
  UUIDs.

### T009
- **Phase**: 1
- **Purpose**: Add a Zod schema for each of the 15 canonical message
  types (§3.1–§3.15) + the WS Ping/Pong documentation note (§3.16 has
  no JSON schema — it's a WS control frame).
- **Files**: `frontend/src/signaling/schema.ts`.
- **Dependencies**: T008.
- **Parallelizable**: no (same file as T008).
- **Definition of Done**: one exported schema per type
  (`joinRoomSchema`, `joinAcceptedSchema`, `joinRejectedSchema`,
  `peerPresenceChangedSchema`, `mediaReadySchema`,
  `mediaFailedSchema`, `readyForOfferSchema`, `offerSchema`,
  `answerSchema`, `iceCandidateSchema`, `mediaStateSchema`,
  `peerLeftSchema`, `participantReleasedSchema`,
  `leaveRoomSchema`, `errorSchema`); each enforces payload shape,
  enum values, and the canonical `payload.result` strings exactly as
  written in contract §3; `media_ready` rejects unless `audio === true`
  **and** `video === true`; `ice_candidate` accepts
  `candidate: null` and rejects `candidate: ""`.
- **Verification**: unit tests in T011 cover accept + reject cases for
  every schema.

### T010
- **Phase**: 1
- **Purpose**: Expose a single source of static types so `dispatcher`,
  `client`, reducers, and components all consume the same type shape.
- **Files**: `frontend/src/types/contract.ts` (a regular `.ts` module,
  not a `.d.ts`, because the types are derived from runtime Zod schemas
  via `z.infer` — a declaration-only file would fight module emit).
  Alternative acceptable layout: re-export the inferred types from
  `frontend/src/signaling/schema.ts` directly and skip a separate
  module altogether.
- **Dependencies**: T008, T009.
- **Parallelizable**: yes — different file than schema.
- **Definition of Done**: `type SignalingMessage = z.infer<…>`
  discriminated on `type`; one exported type per message; no
  hand-written duplication of payload shapes.
- **Verification**: `tsc --noEmit` succeeds; `dispatcher.ts` (T037)
  imports from this module.

### T011
- **Phase**: 1
- **Purpose**: Guarantee every schema accepts the contract's
  canonical examples and rejects the illegal shapes the contract calls
  out (room-full must not be its own type; `candidate: ""`; `media_ready`
  with `audio: false`; `v != 1`; unknown enum values).
- **Files**: `frontend/tests/unit/schema.spec.ts`.
- **Dependencies**: T008, T009.
- **Parallelizable**: yes (different file from Go tests).
- **Definition of Done**: one `describe` per message with at least
  (a) happy-path accept, (b) each reject case the contract calls out;
  includes a test that asserts `v: 2` is rejected as
  `unsupported_version`, `ice_candidate` with `candidate: ""` is
  `malformed`, and `media_ready` with `audio: false` fails.
- **Verification**: `cd frontend && npx vitest run` is green.

### T012
- **Phase**: 1
- **Purpose**: Go counterpart of T008 — shared envelope type, `Type`
  enum, room-ID regex, JSON marshalers, and a generic dispatch helper.
- **Files**: `signaling/internal/signaling/envelope.go`.
- **Dependencies**: T005.
- **Parallelizable**: no (T013 extends sibling file; keep them
  sequential to avoid merge conflicts on the `Type` enum).
- **Definition of Done**: `Envelope` struct; exported `Type` string
  constants for all 15 message types matching contract spelling
  exactly; a `RoomIDRegex` package var; a `Decode(raw []byte)`
  helper returning a tagged union.
- **Verification**: T014 unit tests pass; `go vet ./...` clean.

### T013
- **Phase**: 1
- **Purpose**: Define per-message payload structs (§3.1–§3.15) and
  their `Validate()` methods. This is the Go mirror of the Zod schemas,
  including the exact `payload.result` string values.
- **Files**: `signaling/internal/signaling/messages.go`.
- **Dependencies**: T012.
- **Parallelizable**: no (same package as T012).
- **Definition of Done**: one struct + one `Validate()` per message;
  `Validate()` on `MediaReady` rejects unless both audio and video are
  true; `IceCandidate.Validate()` rejects `candidate: ""` and accepts
  `candidate == nil`; `JoinRejected` result is an enum limited to
  `join_rejected_room_full` / `join_rejected_invalid_room`;
  `ParticipantReleased.Result` is limited to the two canonical values
  from contract §3.13; error codes match contract §3.15 table exactly.
- **Verification**: T014 tests.

### T014
- **Phase**: 1
- **Purpose**: Prevent contract drift — test accept + reject for every
  message type, symmetric to T011 on the frontend.
- **Files**: `signaling/tests/messages_test.go`.
- **Dependencies**: T012, T013.
- **Parallelizable**: yes — different file from frontend tests.
- **Definition of Done**: tests cover every message's happy path + at
  least one reject; includes `TestUnsupportedVersion`,
  `TestMediaReadyRequiresBothAudioAndVideo`,
  `TestIceCandidateRejectsEmptyString`,
  `TestJoinRejectedResultEnum`,
  `TestRoomIDValidation` (length 0, length 65, illegal chars).
- **Verification**: `cd signaling && go test ./...` green.

**Phase 1 exit criterion**: both test suites green; no new message
names exist anywhere; Zod types and Go types cover exactly the 15
canonical messages.

---

## Phase 2 — Signaling server baseline

**Goal**: a Go process on `:8080` with `/healthz`, `/ws`, JSON-slog
logging, connection lifecycle logs, and a 5 s Ping / 5 s Pong-timeout
heartbeat. Still **no** room logic and **no** media relay.

- [ ] T015 Implement `/healthz` endpoint + HTTP server bootstrap — `signaling/cmd/signaling/main.go`
- [ ] T016 [P] Configure `log/slog` with JSON default, `LOG_FORMAT=text` override — `signaling/internal/logging/slog_setup.go`
- [ ] T017 Implement `/ws` upgrader + per-connection read loop — `signaling/internal/signaling/handler.go`
- [ ] T018 Implement heartbeat (5 s Ping interval, 5 s Pong deadline) — `signaling/internal/signaling/heartbeat.go`
- [ ] T019 Emit structured `ws_connected` / `ws_disconnected` log events — `signaling/internal/signaling/handler.go`
- [ ] T020 [P] Handler + heartbeat unit tests (pong-timeout closes within 10 s) — `signaling/tests/heartbeat_test.go`

### T015
- **Phase**: 2 — Signaling server baseline
- **Purpose**: Give the container a real process to start: `net/http`
  on `:8080` with `/healthz` returning `{"status":"ok"}`.
- **Files**: `signaling/cmd/signaling/main.go`.
- **Dependencies**: T005, T016.
- **Parallelizable**: no — file is the entry point others extend.
- **Definition of Done**: `/healthz` returns HTTP 200 with
  `{"status":"ok"}`; server listens on `:8080` (configurable via
  `SIGNALING_PORT`); clean shutdown on SIGTERM.
- **Verification**: `curl http://localhost:8080/healthz` →
  `{"status":"ok"}`.

### T016
- **Phase**: 2
- **Purpose**: Structured JSON logging is NFR — SDP / ICE / credentials
  MUST NEVER land in logs (NFR-003).
- **Files**: `signaling/internal/logging/slog_setup.go`.
- **Dependencies**: —
- **Parallelizable**: yes.
- **Definition of Done**: a `Setup()` helper returns a `*slog.Logger`;
  default handler is JSON; setting `LOG_FORMAT=text` switches to text
  for local dev; level configurable via `LOG_LEVEL`.
- **Verification**: unit test asserts default output is valid JSON and
  does not contain the strings `sdp=`, `candidate:`, `credential=`.

### T017
- **Phase**: 2
- **Purpose**: Accept WebSocket connections at `/ws`; read text
  frames; reply only with a JSON-validated `error` if the envelope
  schema fails. Still no room logic.
- **Files**: `signaling/internal/signaling/handler.go`.
- **Dependencies**: T012, T015.
- **Parallelizable**: no.
- **Definition of Done**: uses `github.com/coder/websocket`; one
  goroutine per connection; read loop decodes JSON via
  `envelope.Decode`; unknown / malformed frames reply with
  `error{code:"malformed"}` and continue the connection;
  goroutine exits on `ctx` cancel or read error.
- **Verification**: manual `wscat` connect succeeds; sending
  `{"v":2,"type":"join_room"}` returns an `error` with
  `unsupported_version`.

### T018
- **Phase**: 2
- **Purpose**: Satisfy SC-009 (≤ 10 s ungraceful-disconnect detection)
  via the 5 s Ping / 5 s Pong-deadline layout documented in contract
  §3.16.
- **Files**: `signaling/internal/signaling/heartbeat.go`.
- **Dependencies**: T017.
- **Parallelizable**: no (uses handler types).
- **Definition of Done**: Ping interval configurable via
  `PING_INTERVAL_MS` (default 5000); Pong deadline configurable via
  `PONG_TIMEOUT_MS` (default 5000); missed Pong closes the WS and
  invokes a `onDisconnect(peerID, reason="pong_timeout")` hook.
- **Verification**: T020 test forces a Pong timeout and asserts the
  WS closes within ≤ 10 s.

### T019
- **Phase**: 2
- **Purpose**: The event log feature in the UI is supplemented by
  structured server logs; at minimum `ws_connected` and
  `ws_disconnected` must be emitted with a stable `peer_id` (pre-
  `join_accepted`: a temporary connection ID).
- **Files**: `signaling/internal/signaling/handler.go`.
- **Dependencies**: T016, T017.
- **Parallelizable**: no (same file as T017).
- **Definition of Done**: both events are structured JSON with fields
  `event`, `conn_id`, `remote_addr`, `reason` (disconnect only); no
  payload bodies logged.
- **Verification**: manual WS connect/disconnect produces two log
  lines with the expected shape; grep confirms no `sdp`, `candidate:`,
  `credential` substrings.

### T020
- **Phase**: 2
- **Purpose**: Lock in the Pong-timeout SLA; regressions break
  SC-009.
- **Files**: `signaling/tests/heartbeat_test.go`.
- **Dependencies**: T017, T018.
- **Parallelizable**: yes.
- **Definition of Done**: tests
  `TestPongTimeoutClosesWithin10s`, `TestPingIntervalEmits`,
  `TestHandlerRejectsUnsupportedVersion`.
- **Verification**: `cd signaling && go test ./... -run
  'Heartbeat|Handler'` green.

**Phase 2 exit criterion**: `docker compose up` yields a server that
responds on `/healthz`, accepts a WebSocket, logs lifecycle events as
JSON, and closes stale sockets within 10 s.

---

## Phase 3 — Room manager and admission flow

**Goal**: `join_room` / `join_accepted` / `join_rejected` /
`peer_presence_changed` / `leave_room` / `peer_left` work end-to-end,
with two-slot capacity, room-full rejection, invalid-room rejection,
and clean leave + disconnect behavior. No media messages yet.

- [ ] T021 Implement `MediaReadiness` + `CallPhase` enums and their transition helpers — `signaling/internal/room/state.go`
- [ ] T022 Implement `Room` (two reserved slots, `rolesAssigned`, mutex, derived call-readiness) — `signaling/internal/room/room.go`
- [ ] T023 Implement `RoomManager` (`Admit`, `Release`, empty-room GC) — `signaling/internal/room/manager.go`
- [ ] T024 Wire `join_room` / `join_accepted` / `join_rejected` in the handler (room-full = `join_rejected_room_full`, invalid-room = `join_rejected_invalid_room`) — `signaling/internal/signaling/handler.go`
- [ ] T025 Emit `peer_presence_changed` broadcasts on admission — `signaling/internal/signaling/handler.go`
- [ ] T026 Wire `leave_room` + in-call-only `peer_left` convenience message — `signaling/internal/signaling/handler.go`
- [ ] T027 [P] Unit tests for `RoomManager` (admit, full, invalid, release, empty-GC) — `signaling/tests/room_manager_test.go`
- [ ] T028 Protocol-flow tests (two clients join, third rejected, leave, disconnect) — `signaling/tests/protocol_flow_test.go`

### T021
- **Phase**: 3 — Room manager and admission flow
- **Purpose**: Codify the two orthogonal enums from data-model §A.3
  (`MediaReadiness` × `CallPhase`), plus transition helpers that
  reject invalid transitions with an `error` response per
  data-model §A.3 "Rejected transitions".
- **Files**: `signaling/internal/room/state.go`.
- **Dependencies**: —
- **Parallelizable**: no (foundation for T022–T023).
- **Definition of Done**: enums exported as typed constants; helper
  `AdvanceMedia(from, to) (ok bool)` + `AdvanceCall(from, to) (ok
  bool)` that enforce the state-machine diagrams.
- **Verification**: `go test ./internal/room -run State`.

### T022
- **Phase**: 3
- **Purpose**: `Room` owns the two reserved slots, the monotonic
  `admissionCounter`, the `rolesAssigned` flag, and the derived
  call-readiness (`empty`, `waiting_for_media`, `waiting_for_peer`,
  `paired`) computed per data-model §A.2.
- **Files**: `signaling/internal/room/room.go`.
- **Dependencies**: T021.
- **Parallelizable**: no.
- **Definition of Done**: `CallReadiness()` is derived, not stored;
  admission is based on slot occupancy, not on call-readiness;
  released slots never renumber the remaining participant;
  `rolesAssigned` resets on any slot release.
- **Verification**: T027 exercises all four call-readiness states.

### T023
- **Phase**: 3
- **Purpose**: `RoomManager.Admit` implements §A.1: create room on
  first join, enforce 2-slot capacity, return `JoinResult`
  (`join_accepted`, `join_rejected_room_full`,
  `join_rejected_invalid_room`). `Release` removes the participant
  and GCs empty rooms.
- **Files**: `signaling/internal/room/manager.go`.
- **Dependencies**: T022.
- **Parallelizable**: no.
- **Definition of Done**: concurrent admissions to the same room are
  serialized; `Admit` rejects an invalid room ID **before** capacity
  check; empty rooms are removed from the `rooms` map.
- **Verification**: T027 covers all three outcomes + concurrency.

### T024
- **Phase**: 3
- **Purpose**: Connect the handler to `RoomManager` for the three
  admission-path messages, emitting exactly the envelope shapes
  defined in contract §3.1–§3.3.
- **Files**: `signaling/internal/signaling/handler.go`.
- **Dependencies**: T017, T023.
- **Parallelizable**: no.
- **Definition of Done**: on `join_room`, handler calls
  `RoomManager.Admit` and replies with exactly one of
  `join_accepted` or `join_rejected`; `join_rejected.payload.result`
  is one of the two canonical strings; a third joiner to a
  two-reserved-slot room receives `join_rejected_room_full` within
  2 s (SC-003); invalid room IDs receive
  `join_rejected_invalid_room`. Envelope `from` is omitted on S→C
  system messages per contract §3.2 note.
- **Verification**: T028 flow tests.

### T025
- **Phase**: 3
- **Purpose**: On each admission, broadcast
  `peer_presence_changed(presence="pending-media", reason="admitted")`
  to both reserved participants (including the subject) per contract
  §3.4 and FR-022b.
- **Files**: `signaling/internal/signaling/handler.go`.
- **Dependencies**: T024.
- **Parallelizable**: no (same file as T024).
- **Definition of Done**: both participants see the admission event;
  the message's `subjectPeerId` and `admissionOrder` match the newly
  admitted participant.
- **Verification**: T028 asserts both WS clients receive the event.

### T026
- **Phase**: 3
- **Purpose**: Implement graceful `leave_room` per contract §3.14 +
  data-model §C.6: always broadcast `peer_presence_changed`;
  **additionally** emit the convenience `peer_left` message **only**
  if the departing participant was in-call
  (`callPhase ∈ {role-assigned, negotiating, connected}`).
  Pending-media departures emit `peer_presence_changed(presence=
  "released")` alone — no `peer_left`.
- **Files**: `signaling/internal/signaling/handler.go`.
- **Dependencies**: T024, T025.
- **Parallelizable**: no.
- **Definition of Done**: the in-call-vs-pending-media classification is
  captured **before** state mutation; `rolesAssigned = false` is reset;
  empty rooms are GC'd; ungraceful WS close uses the same classification
  path via `onDisconnect` (wired in Phase 12 T085).
- **Verification**: Phase 3 T028 covers the **pre-pairing** branch
  (`TestGracefulLeavePrePairingNoPeerLeft`,
  `TestPendingMediaLeaveDoesNotEmitPeerLeft`). The **in-call** branch
  (`TestInCallLeaveEmitsPeerLeft`) requires role assignment +
  offer/answer relay, which first exist in Phase 4; it is exercised
  by T034B and T086.

### T027
- **Phase**: 3
- **Purpose**: Unit-test the room manager against data-model §A.1–§A.3.
- **Files**: `signaling/tests/room_manager_test.go`.
- **Dependencies**: T021–T023.
- **Parallelizable**: yes — isolated from handler edits.
- **Definition of Done**: tests include `TestAdmitAcceptsTwo`,
  `TestAdmitRejectsThirdWithRoomFull`,
  `TestAdmitRejectsInvalidRoomID`, `TestReleaseGCsEmptyRoom`,
  `TestReleaseDoesNotRenumberRemaining`, `TestRolesAssignedResetsOnRelease`.
- **Verification**: `go test ./internal/room/...` green.

### T028
- **Phase**: 3
- **Purpose**: Exercise the full handler + manager + message-layer
  stack over real WebSockets, to catch integration bugs that unit
  tests miss.
- **Files**: `signaling/tests/protocol_flow_test.go`.
- **Dependencies**: T024–T026.
- **Parallelizable**: no (writes handler-level flow fixtures).
- **Definition of Done**: tests scoped to **Phase 3** admission flow
  only: `TestTwoClientsJoinAndSeePresence`,
  `TestThirdJoinRejectedRoomFull`, `TestInvalidRoomIDRejected`,
  `TestGracefulLeavePrePairingNoPeerLeft`,
  `TestPendingMediaLeaveDoesNotEmitPeerLeft`,
  `TestPendingMediaDisconnectDoesNotEmitPeerLeft`. In-call departure
  tests (`TestInCallLeaveEmitsPeerLeft`,
  `TestInCallDisconnectEmitsPeerLeft`) require role-assignment +
  offer/answer relay; they belong to T034B / T086 and MUST NOT be
  written here (no `callPhase ∈ {role-assigned, …}` state exists in
  Phase 3).
- **Verification**: `go test ./tests/...` green.

**Phase 3 exit criterion**: two Go test harness clients can join a room
and receive `peer_presence_changed`; a third is rejected with
`join_rejected_room_full`; graceful and ungraceful departures follow
the `peer_presence_changed`-always / `peer_left`-in-call-only rule.

---

## Phase 4 — Two-phase join and media readiness

**Goal**: `media_ready` / `media_failed` / `participant_released` /
`ready_for_offer` flow end-to-end. Pending-media visibility and
pending-media disconnect cleanup both work. Role assignment is
deterministic by `admissionOrder` (FR-010a / EC-013 — glare
impossible by construction). Still no `RTCPeerConnection` on the
client.

- [ ] T029 Implement `media_ready` / `media_failed` dispatch + state transitions (`pending-media → ready` / `→ failed`) — `signaling/internal/signaling/handler.go`
- [ ] T030 Implement `participant_released` (post-admission release; clears WS room-association so retry-join is accepted) — `signaling/internal/signaling/handler.go`
- [ ] T031 Emit `ready_for_offer` exactly once per pairing when room reaches `paired`; lower `admissionOrder` = offerer — `signaling/internal/signaling/handler.go`
- [ ] T032 Emit `peer_presence_changed` on every `pending-media → ready` transition and every release — `signaling/internal/signaling/handler.go`
- [ ] T033 Pending-media WS-disconnect cleanup (release slot + `peer_presence_changed(presence="released", reason="disconnect")`; no `peer_left`) — `signaling/internal/signaling/handler.go`
- [ ] T034 [P] Protocol-flow tests (media_failed, pending disconnect, both ready → `ready_for_offer` once, role assignment) — `signaling/tests/protocol_flow_test.go`
- [ ] T034A Implement stateful relay validation helpers (sender-admitted, `mediaReadiness`, `callPhase`, assigned-role checks; envelope `from` stamping; remote-peer resolver) — `signaling/internal/room/room.go`, `signaling/internal/signaling/handler.go`
- [ ] T034B Implement `offer` / `answer` relay with split-state validators + `callPhase` advance (`role-assigned → negotiating`) + protocol-flow tests for in-call leave and duplicate-offer rejection — `signaling/internal/signaling/handler.go`, `signaling/tests/protocol_flow_test.go`

### T029
- **Phase**: 4 — Two-phase join and media readiness
- **Purpose**: Transition a `Participant.mediaReadiness` from
  `pending-media` to `ready` (on `media_ready`) or to `failed` (on
  `media_failed`), emitting the correct presence broadcasts per
  contract §3.5 / §3.6.
- **Files**: `signaling/internal/signaling/handler.go`.
- **Dependencies**: T026, T021.
- **Parallelizable**: no.
- **Definition of Done**: `media_ready` with `audio: false` **or**
  `video: false` is rejected with `error{code:
  "unsupported_media_capability"}` (contract §3.15); `media_ready` in
  any state other than `pending-media` is rejected with
  `unexpected_media_ready`; on success the transition fires exactly
  one `peer_presence_changed(presence="ready", reason="media_ready")`
  per peer.
- **Verification**: T034 `TestMediaReadyRejectsIncompleteCapabilities`
  + `TestMediaReadyAdvancesToReady`.

### T030
- **Phase**: 4
- **Purpose**: Post-admission slot release. Must (a) send
  `participant_released` to the affected peer (with canonical
  `result` enum), (b) send `peer_presence_changed(presence=
  "released", reason="media_failed")` to any remaining peer, and
  (c) clear the WS's room association so the same WS may send a new
  `join_room` afterward (contract §3.13 server-side retry support).
- **Files**: `signaling/internal/signaling/handler.go`.
- **Dependencies**: T029.
- **Parallelizable**: no.
- **Definition of Done**: retry flow: same WS can send another
  `join_room` after receiving `participant_released` and is NOT
  rejected with `already_joined`.
- **Verification**: T034 `TestMediaFailedAllowsRetry` +
  `TestParticipantReleasedBroadcastsToRemaining`.

### T031
- **Phase**: 4
- **Purpose**: When the room derived state transitions to `paired`
  (both `mediaReadiness == ready`), assign roles by `admissionOrder`
  (lower = offerer) and send `ready_for_offer` **exactly once** per
  pairing. Re-entries of `paired` caused by idempotent recompute MUST
  NOT re-send (guarded by `Room.rolesAssigned`).
- **Files**: `signaling/internal/signaling/handler.go`.
- **Dependencies**: T029.
- **Parallelizable**: no.
- **Definition of Done**: offerer receives `role: "offerer"`; answerer
  receives `role: "answerer"`; both payloads carry the same
  `iceServers` array sourced from env (not logged); a second paired
  evaluation does not re-send.
- **Verification**: T034 `TestReadyForOfferSentExactlyOncePerPairing`
  + `TestOffererIsLowerAdmissionOrder`.

### T032
- **Phase**: 4
- **Purpose**: Bidirectional pending-media visibility (FR-022b) — both
  participants must see each other's media readiness + release
  transitions.
- **Files**: `signaling/internal/signaling/handler.go`.
- **Dependencies**: T029, T030.
- **Parallelizable**: no (same file).
- **Definition of Done**: `peer_presence_changed` is sent to **both**
  reserved participants (including the subject) on every readiness
  transition, with the correct `reason` tag
  (`admitted`|`media_ready`|`media_failed`|`role_assigned`|`pending_released`|`graceful_leave`|`disconnect`).
- **Verification**: T034 asserts both peers observe the full sequence.

### T033
- **Phase**: 4
- **Purpose**: Close the pending-media-zombie-slot hole (FR-010d,
  risk R-4). If a pending-media WS disconnects, the slot MUST be
  released, the remaining peer notified, and no `peer_left` emitted
  (no PC existed yet).
- **Files**: `signaling/internal/signaling/handler.go`.
- **Dependencies**: T026, T029.
- **Parallelizable**: no.
- **Definition of Done**: WS close for a `pending-media` participant
  invokes the same path as `media_failed` for the remaining peer:
  `peer_presence_changed(presence="released", reason="disconnect")`;
  NO `peer_left` is sent.
- **Verification**: T034 `TestPendingMediaDisconnectReleasesSlotNoPeerLeft`.

### T034
- **Phase**: 4
- **Purpose**: Lock the two-phase-join contract against regressions.
- **Files**: `signaling/tests/protocol_flow_test.go`.
- **Dependencies**: T029–T033.
- **Parallelizable**: yes — independent from frontend work.
- **Definition of Done**: tests named above; plus
  `TestNoGlare_OnlyOffererSendsOffer` (asserts the server rejects
  `offer` from the non-offerer even if sent racily; this guards R-3).
- **Verification**: `go test ./tests/...` green.

### T034A
- **Phase**: 4 — Two-phase join and media readiness (server)
- **Purpose**: Payload-shape validation (T013 `Validate()`) is not
  enough for relay messages — `offer` / `answer` / `ice_candidate` /
  `media_state` require **stateful** checks against the room + sender
  state per data-model §C.2 and contract §§3.8–3.11. Centralize those
  checks so every relay path uses the same helpers.
- **Files**: `signaling/internal/room/room.go` (add helpers like
  `Room.ResolveRemote(peerID)`, `Room.AssignedRole(peerID)`,
  `Participant.CanSendOffer()`, `Participant.CanSendAnswer()`,
  `Participant.CanSendIceCandidate()`, `Participant.CanSendMediaState()`);
  `signaling/internal/signaling/handler.go` (a small
  `validateRelay(msg, sender)` dispatch).
- **Dependencies**: T021, T022, T031.
- **Parallelizable**: no — foundational for T034B, T063A, T074A.
- **Definition of Done**: helpers cover the three-field truth table
  (`role` × `mediaReadiness` × `callPhase`) from contract §§3.8–3.11
  exactly; `validateRelay` returns a typed error that maps 1:1 to the
  contract error codes (`unexpected_offer`, `unexpected_answer`,
  `malformed`, `not_in_room`); relay path always stamps
  `envelope.from = sender.peerID` before forwarding and NEVER parses
  the payload (SDP / ICE strings are opaque bytes at this layer —
  NFR-003).
- **Verification**: unit tests in `signaling/internal/room/` exercise
  each truth-table row; integration coverage comes via T034B / T063A /
  T074A.

### T034B
- **Phase**: 4 — Two-phase join and media readiness (server)
- **Purpose**: Implement the first relay messages — `offer` and
  `answer` — using T034A helpers. Advance the sender's
  `callPhase` through `role-assigned → negotiating` on a legitimate
  offer/answer. This unblocks Phase 7 on the frontend.
- **Files**: `signaling/internal/signaling/handler.go`,
  `signaling/tests/protocol_flow_test.go`.
- **Dependencies**: T031, T034A.
- **Parallelizable**: no.
- **Definition of Done**:
  - `offer` from the role=`offerer` sender is relayed to the answerer
    with `envelope.from = sender.peerID` (contract §3.8).
  - `offer` from the role=`answerer` sender is rejected with
    `error{code:"unexpected_offer"}` — no relay, no state change.
  - A **second** `offer` from the offerer in the same pairing attempt
    (i.e., sender already past `role-assigned`) is rejected with
    `unexpected_offer` (EC-013, R-3).
  - `answer` from the role=`answerer` sender is relayed to the offerer.
  - `answer` from the role=`offerer` sender is rejected with
    `unexpected_answer`.
  - On the first accepted offer (resp. answer), the sender's
    `callPhase` advances `role-assigned → negotiating`.
  - Relay is byte-for-byte except for `envelope.from`; the server does
    NOT parse `payload.sdp.sdp` (NFR-003).
  - Protocol-flow tests added: `TestOfferFromOffererRelayed`,
    `TestOfferFromAnswererRejected`,
    `TestDuplicateOfferRejected`, `TestAnswerFromAnswererRelayed`,
    `TestAnswerFromOffererRejected`, `TestCallPhaseAdvancesOnOffer`,
    plus the in-call departure tests deferred from T028:
    `TestInCallLeaveEmitsPeerLeft`, `TestServerNeverLogsSDP`.
- **Verification**: `go test ./tests/... -run 'Offer|Answer|CallPhase|InCallLeave|NeverLogsSDP'`
  green; grep of captured logs contains no `sdp=` or `candidate:`.

**Phase 4 exit criterion**: Go WS clients can join, report media
readiness, receive `ready_for_offer` exactly once with correct roles,
exchange `offer` / `answer` through the server's stateful relay, and
recover from pending-media failure / disconnect without zombie slots.
The server never touches SDP payload content.

---

## Phase 5 — Frontend baseline

**Goal**: React app connects to `/ws`, sends `join_room`, receives and
validates inbound messages through the Zod schemas, dispatches them
into a reducer, shows the event log and the persistent state indicators
with live values. Still no `getUserMedia` and no `RTCPeerConnection`.

- [ ] T035 Wire top-level app (main, App, layout) — `frontend/src/main.tsx`, `frontend/src/App.tsx`
- [ ] T036 Implement WebSocket client (connect, send, heartbeat echo, close) — `frontend/src/signaling/client.ts`
- [ ] T037 Implement signaling dispatcher (Zod validate → reducer action) — `frontend/src/signaling/dispatcher.ts`
- [ ] T038 [P] Implement session reducer skeleton: `idle → joining`, `joining → pending-media` on `join_accepted`, `joining → idle` on `join_rejected`; `peer_presence_changed` updates remote-peer slice. `waiting-for-peer` is defined but NOT entered here — it is reached only after Phase 6 `media_ready`. — `frontend/src/state/session.ts`
- [ ] T039 [P] Implement event-log slice (ring buffer, 500 entries, transport field on chat) — `frontend/src/state/event-log.ts`
- [ ] T040 Implement event log panel component — `frontend/src/components/EventLogPanel.tsx`
- [ ] T041 [P] Implement persistent state indicators component (FR-022a/b skeleton) — `frontend/src/components/StateIndicators.tsx`
- [ ] T042 Implement `JoinForm` (room ID validation, Join button, disabled during `joining`) — `frontend/src/components/JoinForm.tsx`
- [ ] T043 [P] Dispatcher + reducer unit tests (schema validation failure path, session transitions) — `frontend/tests/unit/session.spec.ts`, `frontend/tests/contract/dispatcher.spec.ts`

### T035
- **Phase**: 5 — Frontend baseline
- **Purpose**: Compose the initial layout (JoinForm, EventLogPanel,
  StateIndicators placeholders) and provide the reducer store via
  context. No business logic here.
- **Files**: `frontend/src/main.tsx`, `frontend/src/App.tsx`,
  `frontend/src/state/index.ts`.
- **Dependencies**: T004.
- **Parallelizable**: no.
- **Definition of Done**: `App.tsx` renders the three components;
  reducer store is provided via context; no direct WS activity yet
  (that's T036).
- **Verification**: `npm run dev`; browser shows empty state; no
  console errors.

### T036
- **Phase**: 5
- **Purpose**: Minimal WS client — `connect(url)`, `send(msg)`,
  `onMessage(cb)`, `close()`. MVP: no auto-reconnect (plan Phase 2).
  Handles browser Pong automatically (the browser responds to server
  Pings automatically).
- **Files**: `frontend/src/signaling/client.ts`.
- **Dependencies**: T008–T010.
- **Parallelizable**: no (T037 wraps it).
- **Definition of Done**: `send(msg)` runs Zod validation on outbound
  messages before JSON.stringify; `onMessage` hands raw strings to
  the dispatcher; exposes `SignalingTransportState` observable.
- **Verification**: `npm run typecheck` passes; T043 dispatcher test
  feeds mocked onMessage callbacks.

### T037
- **Phase**: 5
- **Purpose**: Entry point for inbound messages — parse with the Zod
  schema keyed on `type`, then emit a reducer action. Invalid
  messages log an `error occurred` entry AND send an `error` back to
  the server (data-model §B.9).
- **Files**: `frontend/src/signaling/dispatcher.ts`.
- **Dependencies**: T008–T010, T036, T038–T039.
- **Parallelizable**: no.
- **Definition of Done**: one action per canonical message type;
  unknown `type` or `v != 1` produces an `error occurred` event-log
  entry; no state mutation on validation failure.
- **Verification**: T043 asserts behavior on malformed input +
  unsupported version.

### T038
- **Phase**: 5
- **Purpose**: The top-level `SessionState` FSM from data-model §B.1.
  **Two-phase-join alignment**: `join_accepted` transitions to
  `pending-media`, NOT to `waiting-for-peer`. `waiting-for-peer` is
  reached only after `media_ready` is sent, which first happens in
  Phase 6. The remaining states (`media-error`, `connecting`,
  `connected`, `failed`, `leaving`) land in later phases.
- **Files**: `frontend/src/state/session.ts`.
- **Dependencies**: T035.
- **Parallelizable**: yes (different file than T039, T041).
- **Definition of Done**: pure reducer; handles only the transitions
  reachable in Phase 5:
  `idle → joining`, `joining → pending-media` on `join_accepted`,
  `joining → idle` on `join_rejected`, `pending-media → idle` on
  explicit user Leave (Phase 5 has no media cleanup to run);
  `peer_presence_changed` updates the `remoteParticipant` slice
  regardless of `SessionState`; `SignalingTransportState` lives as a
  separate slice (§B.1.1). Illegal transitions throw.
- **Verification**: T043 session tests assert the four transitions
  above and assert that no direct `joining → waiting-for-peer` path
  exists in the reducer.

### T039
- **Phase**: 5
- **Purpose**: Append-only bounded ring buffer (500 entries) of
  `EventLogEntry` per data-model §B.7; rendered by T040.
- **Files**: `frontend/src/state/event-log.ts`.
- **Dependencies**: T035.
- **Parallelizable**: yes.
- **Definition of Done**: bounded; entries never mutated after
  insertion; supports the `transport?: "signaling" | "datachannel"`
  tag for chat events in Phase 9.
- **Verification**: unit test asserts ring-buffer eviction at 501st
  entry.

### T040
- **Phase**: 5
- **Purpose**: Render the event log in the UI (FR-020/021).
- **Files**: `frontend/src/components/EventLogPanel.tsx`.
- **Dependencies**: T039.
- **Parallelizable**: no (depends on slice).
- **Definition of Done**: scrollable list; timestamp + direction +
  summary per entry; safe text rendering only — no `dangerouslySetInnerHTML`;
  NFR-006.
- **Verification**: manual browser check; Testing-Library test
  asserting text content.

### T041
- **Phase**: 5
- **Purpose**: Render the nine persistent state indicators from
  FR-022a/b. Phase 5 wires the ones that exist at this stage
  (session, signaling-transport, room state, peer presence);
  remainder light up as later phases add state slices.
- **Files**: `frontend/src/components/StateIndicators.tsx`.
- **Dependencies**: T038.
- **Parallelizable**: yes.
- **Definition of Done**: each indicator renders its current enum
  value from the reducer; missing-state values render as `—` or
  `unknown` rather than crashing.
- **Verification**: manual browser check that `session` and
  `signaling-transport` indicators show live values when the WS is
  toggled.

### T042
- **Phase**: 5
- **Purpose**: Entry screen — user types a room ID, clicks Join, we
  send `join_room`.
- **Files**: `frontend/src/components/JoinForm.tsx`.
- **Dependencies**: T036, T038.
- **Parallelizable**: no.
- **Definition of Done**: client-side room ID pre-validation using the
  contract regex; disabled Join button while `session === joining`;
  visible error on `join_rejected`.
- **Verification**: type `invalid room!`, click Join → see invalid-room
  error; type `demo` → session transitions to `joining →
  waiting-for-peer`.

### T043
- **Phase**: 5
- **Purpose**: Lock the dispatcher/reducer contract; prevent future
  refactors from silently swallowing validation errors.
- **Files**: `frontend/tests/unit/session.spec.ts`,
  `frontend/tests/contract/dispatcher.spec.ts`.
- **Dependencies**: T037, T038.
- **Parallelizable**: yes — separate files from production code.
- **Definition of Done**: tests cover (a) each session transition this
  phase supports, (b) dispatcher rejects malformed inbound message
  with an event-log entry, (c) dispatcher emits an `error` message
  back through the client on validation failure.
- **Verification**: `cd frontend && npx vitest run` green.

**Phase 5 exit criterion**: two browser tabs can enter a room ID, send
`join_room`, receive `join_accepted` and enter `pending-media`,
observe their own admission + peer presence + the third-tab room-full
rejection in the event log + state indicators. **No `getUserMedia`,
no `media_ready`, and no transition to `waiting-for-peer` yet** — those
are Phase 6 outcomes.

---

## Phase 6 — Local media acquisition

**Goal**: camera + microphone acquired, local preview visible, `media_ready`
sent on success, `media_failed` sent on failure, `media-error` state
offers a Retry affordance per FR-009 / data-model §B.1. Cleans up
local tracks on explicit Leave.

- [ ] T044 Implement `media-acquisition.ts` (getUserMedia with explicit audio+video constraints, permission-denied + device-missing classification, timeout) — `frontend/src/webrtc/media-acquisition.ts`
- [ ] T045 [P] Implement `LocalVideo.tsx` that renders `localStream` from a ref — `frontend/src/components/LocalVideo.tsx`
- [ ] T046 Wire `media_failed` emission + `participant_released` handling into reducer (`pending-media → media-error`) — `frontend/src/state/session.ts`, `frontend/src/signaling/dispatcher.ts`
- [ ] T047 Add `Retry` + `Leave` affordances to `media-error` state — `frontend/src/components/JoinForm.tsx`, `frontend/src/App.tsx`
- [ ] T048 [P] Implement local track cleanup on explicit Leave (data-model §C.5 Path A for tracks only; full Path A lands in Phase 12) — `frontend/src/webrtc/media-acquisition.ts`
- [ ] T049 [P] Unit tests for media-acquisition reason classification + reducer transitions — `frontend/tests/unit/media-acquisition.spec.ts`

### T044
- **Phase**: 6 — Local media acquisition
- **Purpose**: Wrap `navigator.mediaDevices.getUserMedia({audio:true,
  video:true})`; map browser errors (`NotAllowedError`,
  `NotFoundError`, `NotReadableError`, other) to the contract's
  `media_failed.payload.reason` enum.
- **Files**: `frontend/src/webrtc/media-acquisition.ts`.
- **Dependencies**: T036.
- **Parallelizable**: no.
- **Definition of Done**: explicit audio+video constraints (MVP does
  not allow audio-only / video-only); returns `{stream}` on success
  or `{reason}` on failure; never throws into the caller's reducer;
  exposes `stopTracks()` for cleanup.
- **Verification**: T049 unit tests with mocked `getUserMedia`.

### T045
- **Phase**: 6
- **Purpose**: Render the local stream. Must NOT pass `MediaStream`
  through React state — it lives in a ref per data-model §B.2.
- **Files**: `frontend/src/components/LocalVideo.tsx`.
- **Dependencies**: T044.
- **Parallelizable**: yes — different file.
- **Definition of Done**: `<video autoPlay muted playsInline>`;
  `srcObject` attached via effect; unmount detaches; no memory leak
  on re-mount.
- **Verification**: manual browser check — granting camera shows self
  preview within 1 s.

### T046
- **Phase**: 6
- **Purpose**: Drive the session FSM from media outcome: on
  `{stream}` send `media_ready`, transition to `waiting-for-peer`;
  on `{reason}` send `media_failed`, and on server
  `participant_released` transition to `media-error` (retry-able).
- **Files**: `frontend/src/state/session.ts`,
  `frontend/src/signaling/dispatcher.ts`.
- **Dependencies**: T038, T044.
- **Parallelizable**: no.
- **Definition of Done**: `media-error` is reached ONLY via
  `participant_released`; reserved terminal `failed` is NOT used for
  media failures (data-model §B.1 Key distinctions).
- **Verification**: T049 reducer tests.

### T047
- **Phase**: 6
- **Purpose**: The Retry / Leave affordances per FR-009 — Retry
  returns to `joining`, Leave returns to `idle`.
- **Files**: `frontend/src/components/JoinForm.tsx` (extension),
  `frontend/src/App.tsx`.
- **Dependencies**: T046.
- **Parallelizable**: no (same file as T042).
- **Definition of Done**: buttons visible only in `media-error`;
  Retry re-runs the media acquisition path without reconnecting the
  WS.
- **Verification**: quickstart §5.1.

### T048
- **Phase**: 6
- **Purpose**: Partial implementation of data-model §C.5 Path A
  limited to local tracks (camera/mic). Full cleanup ordering with
  PC + DC + WS lands in Phase 12 T075.
- **Files**: `frontend/src/webrtc/media-acquisition.ts`.
- **Dependencies**: T044.
- **Parallelizable**: yes.
- **Definition of Done**: on explicit Leave the local MediaStream is
  stopped track-by-track; device-in-use indicator disappears within
  5 s (SC-005).
- **Verification**: manual check — after Leave, the browser's
  camera/mic indicator turns off.

### T049
- **Phase**: 6
- **Purpose**: Guard the reason-classification logic — browser
  differences (`NotAllowedError` vs `NotFoundError`) are where
  regressions hide.
- **Files**: `frontend/tests/unit/media-acquisition.spec.ts`.
- **Dependencies**: T044, T046.
- **Parallelizable**: yes.
- **Definition of Done**: tests for `permission_denied`,
  `device_not_found`, `device_in_use`, `other`; tests for reducer
  transitions into and out of `media-error`.
- **Verification**: `npx vitest run` green.

**Phase 6 exit criterion**: both tabs acquire media, preview local
video, and reach `waiting-for-peer` on success; denying permission
shows a retry affordance and does not advance to negotiation.

---

## Phase 7 — Offer/answer negotiation

**Goal**: offerer (lower `admissionOrder`) creates `RTCPeerConnection`,
attaches local tracks, creates a DataChannel **before** `createOffer`,
sends `offer`; answerer sets remote description, creates answer, sends
`answer`; both reach `signalingState === "stable"`. **ICE candidate
relay is deferred to Phase 8** (browser gathers locally; we do not
yet wire `onicecandidate`).

- [ ] T050 Implement `peer-connection.ts` wrapper (create PC with `iceServers`, attach tracks, expose events) — `frontend/src/webrtc/peer-connection.ts`
- [ ] T051 Wire `ready_for_offer` → PC creation + offerer/answerer branching — `frontend/src/webrtc/peer-connection.ts`, `frontend/src/state/peer-connection.ts`
- [ ] T052 Offerer path: `createDataChannel("chat")` before `createOffer`; `setLocalDescription`; send `offer` — `frontend/src/webrtc/peer-connection.ts`
- [ ] T053 Answerer path: `setRemoteDescription(offer)`; `createAnswer`; `setLocalDescription`; send `answer` — `frontend/src/webrtc/peer-connection.ts`
- [ ] T054 Offerer receives `answer`; `setRemoteDescription(answer)` — `frontend/src/webrtc/peer-connection.ts`
- [ ] T055 [P] Log every `signalingstatechange` + offer/answer event into the event log — `frontend/src/state/peer-connection.ts`, `frontend/src/state/event-log.ts`
- [ ] T056 [P] Protocol-flow test `TestOnlyOffererSendsOffer` (R-3 glare guard) — `signaling/tests/protocol_flow_test.go`

### T050
- **Phase**: 7 — Offer/answer negotiation
- **Purpose**: Centralize `RTCPeerConnection` lifecycle — one module
  owns it so Phase 8 (ICE), Phase 9 (DataChannel), Phase 10 (tracks),
  and Phase 11 (replaceTrack) plug in without duplication.
- **Files**: `frontend/src/webrtc/peer-connection.ts`,
  `frontend/src/state/peer-connection.ts`.
- **Dependencies**: T044, T046.
- **Parallelizable**: no.
- **Definition of Done**: module exports `createPeerConnection({iceServers,
  role})`, `attachLocalTracks(stream)`, `close()`; `PeerConnectionState`
  slice holds the four `RTCPeerConnection` getters; the
  `RTCPeerConnection` object itself lives in a ref.
- **Verification**: manual trace in event log; the Phase 12 cleanup
  tests (T087) exercise the wrapper's `close()`.

### T051
- **Phase**: 7
- **Purpose**: Client MUST NOT create a PC before receiving
  `ready_for_offer` (contract §3.7 conformance §6). On receipt,
  construct PC with the server-supplied `iceServers`, attach local
  tracks, and branch on `role`.
- **Files**: `frontend/src/webrtc/peer-connection.ts`,
  `frontend/src/state/peer-connection.ts`.
- **Dependencies**: T050.
- **Parallelizable**: no.
- **Definition of Done**: receipt of `ready_for_offer` triggers PC
  creation exactly once per pairing; late duplicates log
  `unexpected_ready_for_offer` and are ignored; `session` transitions
  `waiting-for-peer → connecting`.
- **Verification**: manual trace in event log; two-browser run shows
  session transitions `waiting-for-peer → connecting` on `ready_for_offer`
  receipt.

### T052
- **Phase**: 7
- **Purpose**: Offerer creates the DataChannel before `createOffer`
  so SDP contains a data m-line (contract §3.7 + plan Phase 5 note);
  the DC is opened but **not used** until Phase 9.
- **Files**: `frontend/src/webrtc/peer-connection.ts`.
- **Dependencies**: T051.
- **Parallelizable**: no.
- **Definition of Done**: `createDataChannel("chat")` precedes
  `createOffer`; offer SDP contains `m=application` section; offer
  message conforms to contract §3.8.
- **Verification**: inspect offer SDP in event log (debug expand) or
  via a `Vitest` snapshot of the produced SDP.

### T053
- **Phase**: 7
- **Purpose**: Answerer consumes the offer, produces the answer, and
  sends it back.
- **Files**: `frontend/src/webrtc/peer-connection.ts`.
- **Dependencies**: T051.
- **Parallelizable**: no (same file as T052).
- **Definition of Done**: `setRemoteDescription(offer)` →
  `createAnswer` → `setLocalDescription` → send `answer`; answerer
  registers `ondatachannel` (no user of it until Phase 9).
- **Verification**: both peers reach `signalingState === "stable"`
  per plan Phase 5 DoD.

### T054
- **Phase**: 7
- **Purpose**: Offerer consumes the answer.
- **Files**: `frontend/src/webrtc/peer-connection.ts`.
- **Dependencies**: T053.
- **Parallelizable**: no.
- **Definition of Done**: `setRemoteDescription(answer)` succeeds
  without `InvalidStateError`; `signalingState` ends at `stable`.
- **Verification**: event log shows `answer received` → `signaling
  state changed → stable`.

### T055
- **Phase**: 7
- **Purpose**: Satisfy FR-020 / FR-021 for the negotiation phase.
- **Files**: `frontend/src/state/peer-connection.ts`,
  `frontend/src/state/event-log.ts`.
- **Dependencies**: T050–T054.
- **Parallelizable**: yes — touches slices, not `peer-connection.ts`.
- **Definition of Done**: event-log entries for `offer created`,
  `offer received`, `answer created`, `answer received`,
  `signaling state changed`; each has direction `local`/`remote`.
- **Verification**: manual check in quickstart §4.1.

### T056
- **Phase**: 7
- **Purpose**: Guard risk R-3 — glare is impossible by the
  deterministic-offerer design; this test makes that guarantee
  executable on the server side.
- **Files**: `signaling/tests/protocol_flow_test.go`.
- **Dependencies**: T031.
- **Parallelizable**: yes — different file from client work.
- **Definition of Done**: test named `TestOnlyOffererSendsOffer`
  verifies the server rejects `offer` from the role=`answerer`
  participant with `error{code: "unexpected_offer"}`; and a second
  `offer` from the same offerer in the same pairing is rejected
  similarly.
- **Verification**: `go test ./tests/...` green.

**Phase 7 exit criterion**: both peers reach stable signaling state;
SDPs contain audio + video + data m-lines; no `RTCPeerConnection`
is ever created before `ready_for_offer`.

---

## Phase 8 — ICE candidate exchange and remote media

**Goal**: trickle ICE both directions, end-of-candidates signaled as
`candidate: null`, remote-arriving candidates buffered until
`setRemoteDescription` resolves, remote `ontrack` renders, connection
reaches `connected` within 5 s on localhost (SC-002). Learning
Inspector shows at least one `host` candidate pair.

- [ ] T057 Wire `onicecandidate` → send `ice_candidate`; send `{candidate: null}` on end-of-candidates — `frontend/src/webrtc/peer-connection.ts`
- [ ] T058 Implement `IceBuffer` (buffer remote candidates until remote description is set; drain on resolve; clear on cleanup) — `frontend/src/webrtc/ice-buffer.ts`
- [ ] T059 On inbound `ice_candidate`: addIceCandidate OR buffer; handle `candidate: null` — `frontend/src/webrtc/peer-connection.ts`
- [ ] T060 [P] Implement `RemoteVideo.tsx` from `ontrack`; add audio track autoplay — `frontend/src/components/RemoteVideo.tsx`
- [ ] T061 [P] Log `iceconnectionstatechange`, `icegatheringstatechange`, `connectionstatechange` into event log — `frontend/src/state/peer-connection.ts`, `frontend/src/state/event-log.ts`
- [ ] T062 Implement Learning Inspector v1 (FR-030): SDP m-lines, ICE candidate types (`host`/`srflx`/`prflx`/`relay`), STUN/TURN configured vs observed — `frontend/src/webrtc/learning-inspector.ts`, `frontend/src/components/LearningInspector.tsx`
- [ ] T063 [P] Unit tests for `IceBuffer` (reordered candidates, early candidates buffered, late null drain) — `frontend/tests/unit/ice-buffer.spec.ts`
- [ ] T063A Implement server-side `ice_candidate` relay (stateful validators; relay `candidate` object and `candidate: null`; reject `candidate: ""`; never parse / log candidate strings) — `signaling/internal/signaling/handler.go`, `signaling/tests/protocol_flow_test.go`

### T057
- **Phase**: 8 — ICE candidate exchange and remote media
- **Purpose**: Send every local ICE candidate as an `ice_candidate`
  message; the browser emits a final `onicecandidate` event with a
  null candidate — relay that as `{candidate: null}` (contract §3.10).
- **Files**: `frontend/src/webrtc/peer-connection.ts`.
- **Dependencies**: T050.
- **Parallelizable**: no.
- **Definition of Done**: every local candidate is sent; end-of-
  candidates is `{candidate: null}` (not `""`); outbound messages
  validate against `iceCandidateSchema` before send.
- **Verification**: event log shows N `ICE candidate sent` entries +
  one `ICE candidate sent (end-of-candidates)` entry.

### T058
- **Phase**: 8
- **Purpose**: Data-model §B.6 rules — on receive, if
  `remoteDescriptionSet === false`, buffer; on SRD resolve, drain in
  order; on cleanup, clear.
- **Files**: `frontend/src/webrtc/ice-buffer.ts`.
- **Dependencies**: T050.
- **Parallelizable**: no (T059 uses it).
- **Definition of Done**: pure module; deterministic order
  preservation; covered by T063 tests.
- **Verification**: `npx vitest run` green.

### T059
- **Phase**: 8
- **Purpose**: Client-side consumer — inbound `ice_candidate` either
  `addIceCandidate` immediately or buffer; handle `candidate: null`
  as a no-op (end-of-candidates from the remote) without throwing.
- **Files**: `frontend/src/webrtc/peer-connection.ts`.
- **Dependencies**: T057, T058.
- **Parallelizable**: no.
- **Definition of Done**: inbound candidates with `null` are not
  passed to `addIceCandidate`; candidates arriving before
  `setRemoteDescription` are buffered; the buffer drains on SRD
  resolve in order.
- **Verification**: T063 reordered-ice test.

### T060
- **Phase**: 8
- **Purpose**: Render the remote video + audio from `ontrack`.
- **Files**: `frontend/src/components/RemoteVideo.tsx`.
- **Dependencies**: T050.
- **Parallelizable**: yes (different file from peer-connection.ts).
- **Definition of Done**: `<video autoPlay playsInline>`; the
  remote stream is aggregated from `ontrack` events (audio + video
  tracks go into one `MediaStream`); unmount releases the
  `srcObject`.
- **Verification**: quickstart §4.1.

### T061
- **Phase**: 8
- **Purpose**: FR-020 / FR-021 for ICE and connection state.
- **Files**: `frontend/src/state/peer-connection.ts`,
  `frontend/src/state/event-log.ts`.
- **Dependencies**: T050.
- **Parallelizable**: yes.
- **Definition of Done**: four event-log sources wired:
  `onconnectionstatechange`, `oniceconnectionstatechange`,
  `onicegatheringstatechange`, `onsignalingstatechange`; each logs
  new value + previous value.
- **Verification**: quickstart §4.1 log listing.

### T062
- **Phase**: 8
- **Purpose**: Learning Inspector v1 (FR-030): parse local + remote
  SDP to enumerate m-sections; classify ICE candidates by type;
  display STUN/TURN configured (from `iceServers`) vs observed
  (from gathered candidate types).
- **Files**: `frontend/src/webrtc/learning-inspector.ts`,
  `frontend/src/components/LearningInspector.tsx`.
- **Dependencies**: T050, T058.
- **Parallelizable**: no.
- **Definition of Done**: panel shows
  `STUN configured: yes/no`, `srflx observed: yes/no`,
  `TURN configured: yes/no`, `relay candidate present: yes/no`,
  list of m-sections; does NOT log SDP strings.
- **Verification**: on localhost run, panel shows at least one
  `host` candidate and (if public STUN reachable) one `srflx`.

### T063
- **Phase**: 8
- **Purpose**: Lock the buffering invariant.
- **Files**: `frontend/tests/unit/ice-buffer.spec.ts`.
- **Dependencies**: T058.
- **Parallelizable**: yes.
- **Definition of Done**: tests for
  (a) early candidate buffered, (b) SRD resolve drains in order,
  (c) cleanup clears buffer, (d) `null` candidate does not crash
  the buffer.
- **Verification**: `npx vitest run` green.

### T063A
- **Phase**: 8 — ICE candidate exchange and remote media (server)
- **Purpose**: Server-side relay for `ice_candidate` per contract
  §3.10. Without this, T057–T059 frontend work has nothing to talk
  to. Uses T034A stateful helpers.
- **Files**: `signaling/internal/signaling/handler.go`,
  `signaling/tests/protocol_flow_test.go`.
- **Dependencies**: T034A, T013.
- **Parallelizable**: no (touches relay dispatch in handler.go).
- **Definition of Done**:
  - Sender `mediaReadiness == ready` AND
    `callPhase ∈ {role-assigned, negotiating, connected}`; otherwise
    rejected with `error{code:"malformed"}` or a more specific code.
  - Payload with `candidate` object is relayed byte-for-byte to the
    remote peer with `envelope.from = sender.peerID`.
  - Payload with `candidate: null` is relayed identically (end-of-
    candidates).
  - Payload with `candidate: ""` is rejected with
    `error{code:"malformed"}` (contract §3.10 + §3.15).
  - Server NEVER parses, mutates, caches, or logs the candidate
    string (NFR-003).
  - Tests added: `TestIceCandidateRelayed`,
    `TestIceCandidateNullRelayed`, `TestIceCandidateEmptyRejected`,
    `TestIceCandidateFromWrongStateRejected`,
    `TestServerNeverLogsCandidate`.
- **Verification**: `go test ./tests/... -run 'IceCandidate|NeverLogsCandidate'`
  green; grep of captured logs contains no `candidate:` substring.

**Phase 8 exit criterion**: quickstart §4.1 passes — two browsers
see and hear each other; Learning Inspector lists at least one
`host` candidate; SC-001 and SC-002 pass on localhost.

---

## Phase 9 — DataChannel chat

**Goal**: chat works via `RTCDataChannel` (FR-016a). Offerer-created
channel is consumed by the answerer via `ondatachannel`. Event-log
entries are tagged `transport: "datachannel"`.

- [ ] T064 Implement `data-channel.ts` (open/close/send, `onmessage`, backpressure via `bufferedAmount`) — `frontend/src/webrtc/data-channel.ts`
- [ ] T065 Wire offerer's `createDataChannel("chat")` into the reducer (T052 already creates it — this wires the `open`/`close`/`message` lifecycle) — `frontend/src/state/data-channel.ts` (or extend `peer-connection.ts`)
- [ ] T066 Wire answerer's `ondatachannel` handler — `frontend/src/webrtc/peer-connection.ts`
- [ ] T067 [P] Implement `Chat.tsx` (input, send button, scrollable transcript, safe text rendering per NFR-006) — `frontend/src/components/Chat.tsx`
- [ ] T068 [P] Implement chat message validation (FR-015a: trimmed non-empty, ≤500 chars) — `frontend/src/state/chat.ts`
- [ ] T069 [P] Wire chat-channel state indicator (connecting → open → closed) — `frontend/src/components/StateIndicators.tsx`
- [ ] T070 [P] Tag all chat event-log entries with `transport: "datachannel"` — `frontend/src/state/event-log.ts`

### T064
- **Phase**: 9 — DataChannel chat
- **Purpose**: Small wrapper around `RTCDataChannel` that exposes
  `send(text)`, `on("message", cb)`, `state`, `close()`; enforces
  `bufferedAmount` ceiling to avoid browser buffer exhaustion.
- **Files**: `frontend/src/webrtc/data-channel.ts`.
- **Dependencies**: T050.
- **Parallelizable**: no (T065, T066 wrap it).
- **Definition of Done**: exposes a `DataChannelState` observable
  (`absent | connecting | open | closing | closed`).
- **Verification**: T073 contract test + quickstart §4.3.

### T065
- **Phase**: 9
- **Purpose**: Offerer side — attach the DataChannel created in T052 to
  the reducer's `DataChannelState` slice, wire `onopen`/`onclose`/
  `onmessage` to reducer actions.
- **Files**: `frontend/src/state/data-channel.ts` (or extend
  `peer-connection.ts`).
- **Dependencies**: T052, T064.
- **Parallelizable**: no.
- **Definition of Done**: `DataChannelState` transitions mirror the
  `readyState` changes 1:1; event-log entries on each transition.
- **Verification**: manual — open two tabs; verify `open` in both.

### T066
- **Phase**: 9
- **Purpose**: Answerer side — handle `ondatachannel`; attach it to
  the same reducer path as T065.
- **Files**: `frontend/src/webrtc/peer-connection.ts`.
- **Dependencies**: T064.
- **Parallelizable**: no.
- **Definition of Done**: on receipt of `ondatachannel`, the answerer's
  `DataChannelState` transitions `absent → connecting → open`; same
  event-log entries.
- **Verification**: same as T065.

### T067
- **Phase**: 9
- **Purpose**: User-facing chat UI.
- **Files**: `frontend/src/components/Chat.tsx`.
- **Dependencies**: T064–T066, T068.
- **Parallelizable**: yes (different file from channel wrappers).
- **Definition of Done**: input + send button; disabled when
  `DataChannelState !== open`; transcript rendered as text only
  (no `dangerouslySetInnerHTML`) per NFR-006.
- **Verification**: quickstart §4.3 passes; typing `<script>` renders
  as text.

### T068
- **Phase**: 9
- **Purpose**: FR-015a — trim whitespace, reject empty, reject >500
  chars, reject non-string.
- **Files**: `frontend/src/state/chat.ts`.
- **Dependencies**: —
- **Parallelizable**: yes.
- **Definition of Done**: validation is a pure function with
  exhaustive tests; used both on send and on receive (defense in
  depth).
- **Verification**: unit tests for empty, whitespace-only, 500-char,
  501-char, emoji (should pass), HTML-like strings.

### T069
- **Phase**: 9
- **Purpose**: FR-022a — chat-channel state indicator.
- **Files**: `frontend/src/components/StateIndicators.tsx`
  (extension).
- **Dependencies**: T041, T065.
- **Parallelizable**: yes.
- **Definition of Done**: indicator visible before Phase 9 runtime
  (value: `absent`); transitions during the call.
- **Verification**: quickstart §4.3 indicator.

### T070
- **Phase**: 9
- **Purpose**: Event-log transport tagging (US5 Conditional events —
  signaling vs datachannel).
- **Files**: `frontend/src/state/event-log.ts` (extension).
- **Dependencies**: T039.
- **Parallelizable**: yes.
- **Definition of Done**: chat events emitted by `data-channel.ts`
  carry `transport: "datachannel"`; the interim signaling path
  (if enabled) carries `transport: "signaling"`.
- **Verification**: quickstart §4.3 log entry.

> **Phase 9a (optional, off by default)** — a **signaling-relayed**
> chat path, only to teach the contrast (FR-016). It MUST be
> gated behind a dev-mode toggle and MUST be removed before declaring
> MVP complete (FR-016a). This phase is **not** scheduled as a task
> and MUST be removed if enabled during development.

**Phase 9 exit criterion**: chat round-trip over DataChannel between
two browsers; every chat log entry carries `transport: "datachannel"`;
validation rejects empty and oversized messages.

---

## Phase 10 — Media controls (mic / camera)

**Goal**: mute/unmute mic, camera on/off. Remote UI updates via
explicit `media_state` signaling (FR-014a), never inferred from packet
flow. No renegotiation triggered by a toggle.

- [ ] T071 Implement `MediaControls.tsx` (mic button, camera button) — `frontend/src/components/MediaControls.tsx`
- [ ] T072 On toggle: flip `track.enabled` + emit `media_state` (always full triplet: microphone, camera, screenShare) — `frontend/src/state/media.ts`, `frontend/src/webrtc/media-acquisition.ts`
- [ ] T073 Handle inbound `media_state` → update `RemoteMediaState` slice + event log `media toggled` — `frontend/src/state/media.ts`, `frontend/src/signaling/dispatcher.ts`
- [ ] T074 [P] Tests that toggling mic/camera does NOT trigger renegotiation (signalingState stays `stable`) — `frontend/tests/unit/media-controls.spec.ts`
- [ ] T074A Implement server-side `media_state` relay (full triplet required; `mediaReadiness == ready`; relayed to remote peer only; not accepted from pending-media / idle) — `signaling/internal/signaling/handler.go`, `signaling/tests/protocol_flow_test.go`

### T071
- **Phase**: 10 — Media controls
- **Purpose**: Minimal UI for the toggles.
- **Files**: `frontend/src/components/MediaControls.tsx`.
- **Dependencies**: T045.
- **Parallelizable**: no.
- **Definition of Done**: two buttons (Mic / Camera) with on/off
  state; disabled when no local stream; calls through to T072.
- **Verification**: quickstart §4.2.

### T072
- **Phase**: 10
- **Purpose**: Implement the toggle: `track.enabled = !track.enabled`;
  send a **full** `media_state` message (contract §3.11 requires all
  three fields).
- **Files**: `frontend/src/state/media.ts`,
  `frontend/src/webrtc/media-acquisition.ts`.
- **Dependencies**: T071, T044.
- **Parallelizable**: no.
- **Definition of Done**: toggles are idempotent; each emits one
  `media_state` message; no `createOffer` is invoked by the toggle;
  `signalingState` remains `stable`.
- **Verification**: T074 test + quickstart §4.2.

### T073
- **Phase**: 10
- **Purpose**: Consume the remote's `media_state` to update
  `RemoteMediaState`; append one event-log entry per message.
- **Files**: `frontend/src/state/media.ts`,
  `frontend/src/signaling/dispatcher.ts`.
- **Dependencies**: T037.
- **Parallelizable**: no (same dispatcher).
- **Definition of Done**: remote indicator updates within ~1 s of
  local toggle; event-log entry has direction `remote`.
- **Verification**: quickstart §4.2.

### T074
- **Phase**: 10
- **Purpose**: Regression guard: enabling/disabling a track MUST NOT
  cause renegotiation in the MVP (research §4 + plan Phase 10 DoD).
- **Files**: `frontend/tests/unit/media-controls.spec.ts`.
- **Dependencies**: T072.
- **Parallelizable**: yes.
- **Definition of Done**: test asserts `signalingState === "stable"`
  across a toggle sequence; `createOffer` is never called.
- **Verification**: `npx vitest run` green.

### T074A
- **Phase**: 10 — Media controls (server)
- **Purpose**: Server-side relay for `media_state` per contract
  §3.11. Without this, T072/T073 frontend work has nothing to talk
  to. Uses T034A stateful helpers.
- **Files**: `signaling/internal/signaling/handler.go`,
  `signaling/tests/protocol_flow_test.go`.
- **Dependencies**: T034A, T013.
- **Parallelizable**: no.
- **Definition of Done**:
  - All three fields (`microphone`, `camera`, `screenShare`) are
    **required**; payload without any of them fails `Validate()` in
    T013 and is rejected with `error{code:"malformed"}`.
  - Sender `mediaReadiness == ready`; senders in `pending-media` or
    `idle` are rejected (contract §3.11 validation).
  - `callPhase` SHOULD be `connected`; `negotiating` is permitted
    (contract §3.11 wording).
  - Payload is relayed to the **remote peer only** (not broadcast),
    with `envelope.from = sender.peerID`; the server does not log
    the field values.
  - Tests added: `TestMediaStateRelayedToRemoteOnly`,
    `TestMediaStateRejectedFromPendingMedia`,
    `TestMediaStateRequiresFullTriplet`.
- **Verification**: `go test ./tests/... -run MediaState` green.

**Phase 10 exit criterion**: quickstart §4.2 passes; remote indicators
update; no extra offer/answer is exchanged on mic/camera toggle.

---

## Phase 11 — Screen sharing

**Goal**: start/stop screen share via `getDisplayMedia` +
`RTCRtpSender.replaceTrack`; single outgoing video slot (FR-017);
handle both the in-app Stop button and the browser-native stop. On
stop, revert to camera track (if camera was on) or to a
camera-off indicator.

- [ ] T075 Implement `screen-share.ts` (`getDisplayMedia`, `replaceTrack`, stop, `onended` subscriber) — `frontend/src/webrtc/screen-share.ts`
- [ ] T076 [P] Implement `ScreenShareButton.tsx` (start / stop, disabled when `SessionState !== "connected"` or no outgoing video sender) — `frontend/src/components/ScreenShareButton.tsx`
- [ ] T077 On stop (either source): `replaceTrack(cameraTrack)` OR remove track if camera is off; emit `media_state(screenShare=inactive)` — `frontend/src/webrtc/screen-share.ts`
- [ ] T078 [P] Log `screen share started` / `screen share stopped` / `track replaced` with source tag (`app` | `browser`) — `frontend/src/state/event-log.ts`
- [ ] T079 [P] Handle picker cancellation (log `screen share cancelled`, no state change) — `frontend/src/webrtc/screen-share.ts`

### T075
- **Phase**: 11 — Screen sharing
- **Purpose**: Core wrapper — `getDisplayMedia({video:true})`,
  `RTCRtpSender.replaceTrack`, stop path, wiring `onended` on the
  screen track for browser-native stop detection.
- **Files**: `frontend/src/webrtc/screen-share.ts`.
- **Dependencies**: T050, T044.
- **Parallelizable**: no.
- **Definition of Done**: module exports `start()`, `stop(source: "app" |
  "browser")`, `isActive()`; single outgoing video slot preserved; a
  user-provided `getCameraTrack()` hook is called on stop to get the
  camera track to swap back to (or `null` to emit a camera-off
  indicator).
- **Verification**: quickstart §4.4.

### T076
- **Phase**: 11
- **Purpose**: UI entry.
- **Files**: `frontend/src/components/ScreenShareButton.tsx`.
- **Dependencies**: T075.
- **Parallelizable**: yes — different file.
- **Definition of Done**: label flips "Share screen" ↔ "Stop sharing";
  disabled when `SessionState !== "connected"` or when the outgoing
  video `RTCRtpSender` is not available. **Not** gated on
  DataChannel state — screen share rides the video sender, not the
  data channel, and may be usable even if chat is unavailable.
- **Verification**: quickstart §4.4.

### T077
- **Phase**: 11
- **Purpose**: Revert behavior — `replaceTrack(cameraTrack)` when
  camera is on; emit a `media_state` with `screenShare: "inactive"`.
- **Files**: `frontend/src/webrtc/screen-share.ts`.
- **Dependencies**: T075, T072.
- **Parallelizable**: no (same file as T075, T079).
- **Definition of Done**: after stop, remote sees camera again (or a
  camera-off indicator if camera was off); `media_state` carries the
  full triplet; SC-007 (2 s stop latency) met.
- **Verification**: quickstart §4.4 steps 7–8.

### T078
- **Phase**: 11
- **Purpose**: Event log visibility of the swap (US5 Conditional
  events).
- **Files**: `frontend/src/state/event-log.ts` (extension).
- **Dependencies**: T039, T075.
- **Parallelizable**: yes.
- **Definition of Done**: one `screen share started` entry at start;
  one `track replaced` entry per replaceTrack; one
  `screen share stopped` entry at stop with `source: "app" |
  "browser"` field.
- **Verification**: quickstart §4.4 log entries.

### T079
- **Phase**: 11
- **Purpose**: User cancels the OS picker — must not error, just log.
- **Files**: `frontend/src/webrtc/screen-share.ts`.
- **Dependencies**: T075.
- **Parallelizable**: yes — but same file as T075/T077 (beware
  conflict; sequence with T075 if necessary).
- **Definition of Done**: `getDisplayMedia` rejection with
  `NotAllowedError` (picker cancelled) logs
  `screen share cancelled`; no state mutation.
- **Verification**: manual cancel on picker.

**Phase 11 exit criterion**: quickstart §4.4 passes for app-stop AND
browser-stop; picker cancellation logs; SC-007 met.

---

## Phase 12 — Cleanup and failure handling

**Goal**: every cleanup path in data-model §C.5 is implemented
correctly; every failure case in spec Edge Cases (EC-001..EC-013)
behaves as specified.

- [ ] T080 Implement cleanup **Path A** (local Leave): stop local tracks → close DC → close PC → `leave_room` → close WS → reset reducer → event log `path: "local_leave"` — `frontend/src/webrtc/peer-connection.ts`, `frontend/src/state/session.ts`
- [ ] T081 Implement cleanup **Path B** (remote `peer_left`): close DC + PC + clear remote state + clear ICE buffer + **keep** local tracks + `connected → waiting-for-peer` — `frontend/src/signaling/dispatcher.ts`, `frontend/src/state/session.ts`
- [ ] T082 Implement cleanup **Path C** (ICE/fatal PC failure): close DC + PC + clear remote state + `SessionState → failed` + Leave/Rejoin UI; **Rejoin = Path A + fresh Join** (no `release_slot` message) — `frontend/src/state/session.ts`, `frontend/src/components/App.tsx` (or equivalent failure panel)
- [ ] T083 [P] Wire pending-media release cleanup on the client (no `peer_left` processing; remote indicator returns to `absent`) — `frontend/src/signaling/dispatcher.ts`, `frontend/src/state/session.ts`
- [ ] T084 Implement signaling-disconnect handling: during `joining|pending-media|waiting-for-peer|connecting` → `SessionState=failed`; during `connected` → `SignalingTransportState=error` with warning + media continues — `frontend/src/signaling/client.ts`, `frontend/src/state/session.ts`
- [ ] T085 Server-side ungraceful-disconnect detection: WS close OR Pong timeout routes through the same §C.6 classifier as T026 (pending-media → `peer_presence_changed` only; in-call → also `peer_left`) — `signaling/internal/signaling/handler.go`, `signaling/internal/signaling/heartbeat.go`
- [ ] T086 [P] Server protocol-flow tests: `TestRoomFullRejectsWhilePending`, `TestWSPongTimeoutReleasesSlot`, `TestLeaveDuringNegotiation`, `TestInCallDisconnectEmitsPeerLeft`, `TestPendingMediaDisconnectDoesNotEmitPeerLeft` — `signaling/tests/protocol_flow_test.go`
- [ ] T087 [P] Client reducer / PC event tests for all three cleanup paths + both signaling-disconnect branches + `TestIceFailureEntersFailed` (PC `connectionState === "failed"` → `SessionState = failed`) — `frontend/tests/unit/cleanup.spec.ts`

### T080
- **Phase**: 12 — Cleanup and failure handling
- **Purpose**: Data-model §C.5 Path A — the local-Leave path.
- **Files**: `frontend/src/webrtc/peer-connection.ts`,
  `frontend/src/state/session.ts`,
  `frontend/src/webrtc/data-channel.ts`,
  `frontend/src/webrtc/media-acquisition.ts`.
- **Dependencies**: T048, T050, T064.
- **Parallelizable**: no.
- **Definition of Done**: exact step order per §C.5 Path A:
  stop local tracks → close DC → close PC → send `leave_room` (if WS
  alive) → drop refs → close WS → reducer `→ idle` → event log
  `cleanup completed` with `path: "local_leave"`.
- **Verification**: quickstart §4.6 step 11 + T087 tests + SC-005
  (5 s cleanup).

### T081
- **Phase**: 12
- **Purpose**: Data-model §C.5 Path B — the remote-peer_left path.
  This is the one where the bug "local camera turns off when remote
  hangs up" lives if the steps are done in the wrong order.
- **Files**: `frontend/src/signaling/dispatcher.ts`,
  `frontend/src/state/session.ts`.
- **Dependencies**: T080.
- **Parallelizable**: no.
- **Definition of Done**: close DC + PC + clear RemoteMediaState +
  clear ICE buffer; **local MediaStreamTracks remain live**; reducer
  transitions `connecting|connected → waiting-for-peer`; WS stays
  open; event log `cleanup completed` with `path: "remote_peer_left"`.
- **Verification**: quickstart §4.6 step 10 + T087 tests.

### T082
- **Phase**: 12
- **Purpose**: Data-model §C.5 Path C — terminal local failure
  (ICE failure / fatal PC error). Rejoin is a convenience alias
  for "Leave + fresh Join" (no new contract message).
- **Files**: `frontend/src/state/session.ts`, a failure panel
  component (extending `App.tsx` or adding `components/FailurePanel.tsx`).
- **Dependencies**: T080.
- **Parallelizable**: no.
- **Definition of Done**: `SessionState === "failed"` shows
  Leave / Rejoin; Leave runs Path A; Rejoin runs Path A then opens a
  fresh WS and re-enters the normal Join flow; local tracks are
  released on either button (not before); event log
  `cleanup completed` with `path: "local_failure"`.
- **Verification**: quickstart §5.3 (ICE failure) — terminal `failed`
  with Leave/Rejoin; clicking Rejoin re-enters `idle → joining`.

### T083
- **Phase**: 12
- **Purpose**: Client side of pending-media release — when the remote
  was admitted but never became `ready`, we must NOT run Path B
  against an `RTCPeerConnection` that doesn't exist.
- **Files**: `frontend/src/signaling/dispatcher.ts`,
  `frontend/src/state/session.ts`.
- **Dependencies**: T037.
- **Parallelizable**: yes (different from T080–T082 concerns).
- **Definition of Done**: a `peer_presence_changed(presence=
  "released")` updates `remoteParticipant` to `absent` and clears
  the "peer waiting" indicator; `peer_left` is NOT expected in this
  case and would trigger Path B (which must assert that a PC exists).
- **Verification**: quickstart §5.1 + T086 `TestPendingMediaLeaveDoesNotEmitPeerLeft`.

### T084
- **Phase**: 12
- **Purpose**: The teachable moment — signaling can fail while media
  continues, data-model §B.1.1. In the UI, that's a warning, not a
  terminal failure.
- **Files**: `frontend/src/signaling/client.ts`,
  `frontend/src/state/session.ts`.
- **Dependencies**: T036, T080.
- **Parallelizable**: no.
- **Definition of Done**: WS close during `joining|pending-media|
  waiting-for-peer|connecting` → `SessionState = failed`
  (no stable P2P yet); WS close during `connected` →
  `SignalingTransportState = error`, `SessionState` stays
  `connected`, UI shows a "signaling disconnected" warning; graceful
  `leave_room`, `media_state` emission, and screen-share renegotiation
  are disabled until transport recovers or the user Leaves.
- **Verification**: quickstart §5.5.

### T085
- **Phase**: 12
- **Purpose**: Server-side symmetry with T026 — ungraceful disconnect
  classified before state mutation; `peer_presence_changed` always;
  `peer_left` in-call only. Pong timeout closes the WS and routes
  through this classifier.
- **Files**: `signaling/internal/signaling/handler.go`,
  `signaling/internal/signaling/heartbeat.go`.
- **Dependencies**: T018, T026.
- **Parallelizable**: no.
- **Definition of Done**: `onDisconnect(peerID, reason)` where
  `reason ∈ {"ws_close", "pong_timeout"}` releases the slot, emits
  the correct broadcasts per §C.6, and GCs empty rooms; `peer_left`
  is only emitted for in-call departures (`reason: "disconnect"`).
- **Verification**: T086 tests + quickstart §5.4.

### T086
- **Phase**: 12
- **Purpose**: Lock server-observable failure-path behavior. ICE
  failure is **not** here — the server cannot observe PC state, so
  `TestIceFailureEntersFailed` is a frontend test (T087).
- **Files**: `signaling/tests/protocol_flow_test.go`.
- **Dependencies**: T085.
- **Parallelizable**: yes.
- **Definition of Done**: tests `TestRoomFullRejectsWhilePending`
  (a second pending-media reserve also returns
  `join_rejected_room_full`), `TestWSPongTimeoutReleasesSlot`
  (release happens within ≤ 10 s of silence — SC-009),
  `TestLeaveDuringNegotiation` (EC-012),
  `TestInCallDisconnectEmitsPeerLeft` (deferred from T028 — needs
  role-assigned state from T034B),
  `TestPendingMediaDisconnectDoesNotEmitPeerLeft` (guards the
  Path-B-never-against-nonexistent-PC invariant on the server side).
- **Verification**: `go test ./tests/...` green.

### T087
- **Phase**: 12
- **Purpose**: Lock the client cleanup behavior. Also covers
  `TestIceFailureEntersFailed`, which is a frontend PC-event test
  (the server cannot observe `RTCPeerConnection.connectionState`;
  moved here from T086).
- **Files**: `frontend/tests/unit/cleanup.spec.ts`.
- **Dependencies**: T080–T084.
- **Parallelizable**: yes.
- **Definition of Done**: tests named per path A/B/C; assertions
  include "local tracks stopped" vs "local tracks kept"; signaling
  disconnect in each session state transitions correctly;
  `TestIceFailureEntersFailed` simulates an
  `RTCPeerConnection.connectionState === "failed"` event and
  asserts `SessionState = failed` + Leave/Rejoin panel visibility
  (not a Go server concern).
- **Verification**: `npx vitest run` green.

**Phase 12 exit criterion**: every §5 scenario in `quickstart.md`
passes; SC-005 and SC-009 pass; no `go test` or Vitest failures;
no cleanup path touches state it shouldn't.

---

## Phase 13 — Infrastructure and local development

**Goal**: one-command local bring-up with correct env wiring, minimal
production-default safety, and documented optional `coturn`.

- [ ] T088 Write production `frontend/Dockerfile` (multi-stage: Node build → Nginx or Vite preview) — `frontend/Dockerfile`
- [ ] T089 [P] Write `signaling/Dockerfile` (multi-stage: Go builder → scratch/distroless) — `signaling/Dockerfile`
- [ ] T090 Finalize `docker-compose.yml` (env wiring for `VITE_STUN_URLS` / `VITE_TURN_*` / `LOG_FORMAT` / ports; depends-on; healthcheck for signaling) — `docker-compose.yml`
- [ ] T091 [P] Finalize `.env.example` with every consumed var; no secrets — `.env.example`
- [ ] T092 Create `infra/coturn/turnserver.conf.example` (disabled by default) — `infra/coturn/turnserver.conf.example`
- [ ] T093 Add commented `coturn` service block to `docker-compose.yml` with enabling instructions — `docker-compose.yml`
- [ ] T094 Write / update `README.md` local run instructions (quickstart link, `docker compose up --build`, `.env` override guidance) — `README.md`

### T088
- **Phase**: 13 — Infrastructure and local development
- **Purpose**: Production-ish frontend container (still for local
  dev, but not the raw `vite dev` process).
- **Files**: `frontend/Dockerfile`.
- **Dependencies**: T004.
- **Parallelizable**: no.
- **Definition of Done**: multi-stage build; final image serves the
  built assets on port 5173 (or per `FRONTEND_PORT`).
- **Verification**: `docker compose up --build` serves `http://localhost:5173/`.

### T089
- **Phase**: 13
- **Purpose**: Small, reproducible signaling image.
- **Files**: `signaling/Dockerfile`.
- **Dependencies**: T005.
- **Parallelizable**: yes.
- **Definition of Done**: `FROM golang:1.22 AS builder` → `FROM
  gcr.io/distroless/static` (or `scratch`); binary runs under non-
  root user; exposes `:8080`.
- **Verification**: `docker compose up --build` logs `listening`
  within 1 s.

### T090
- **Phase**: 13
- **Purpose**: Wire env into both services; add a healthcheck on the
  signaling service so `docker compose up` blocks correctly.
- **Files**: `docker-compose.yml`.
- **Dependencies**: T088, T089, T015.
- **Parallelizable**: no.
- **Definition of Done**: `VITE_*` vars forwarded into the frontend
  build args; `LOG_FORMAT`, `PING_INTERVAL_MS`, `PONG_TIMEOUT_MS`
  forwarded into signaling runtime; healthcheck hits `/healthz`;
  ports documented; `depends_on` with `condition: service_healthy`.
- **Verification**: quickstart §2 + §3.

### T091
- **Phase**: 13
- **Purpose**: Keep `.env.example` in sync with what the code reads.
- **Files**: `.env.example`.
- **Dependencies**: T007 + every env var introduced through Phase 12.
- **Parallelizable**: yes.
- **Definition of Done**: grep the repo for `process.env.` and
  `os.Getenv(` — each key is present; TURN block still commented out
  by default.
- **Verification**: compare `grep -R` output with `.env.example` keys.

### T092
- **Phase**: 13
- **Purpose**: Make TURN optional but first-class learnable.
- **Files**: `infra/coturn/turnserver.conf.example`.
- **Dependencies**: T002.
- **Parallelizable**: no (T093 references it).
- **Definition of Done**: sensible dev defaults; credentials sourced
  from env, not baked in; commented lines explain each knob.
- **Verification**: uncommenting the `coturn` block + setting
  `VITE_TURN_*` yields a working relay candidate (quickstart §6).

### T093
- **Phase**: 13
- **Purpose**: Add the `coturn` service to compose, **commented**, so
  the default `docker compose up` still works without TURN.
- **Files**: `docker-compose.yml`.
- **Dependencies**: T092.
- **Parallelizable**: no.
- **Definition of Done**: commented block uses `coturn/coturn` image,
  mounts the example conf, exposes 3478/udp; an inline comment
  describes how to enable.
- **Verification**: `docker compose config` still parses with the
  block commented; uncommenting + a TURN env triggers a relay
  candidate in Learning Inspector.

### T094
- **Phase**: 13
- **Purpose**: Make the README self-sufficient for a fresh clone.
- **Files**: `README.md`.
- **Dependencies**: T001, T090–T093.
- **Parallelizable**: no.
- **Definition of Done**: sections for "Quick start", "Enable TURN",
  "Run tests", "Directory layout"; all link to `specs/001-webrtc-1to1-call/quickstart.md`
  for the full walkthrough.
- **Verification**: a stranger clones the repo and can run the happy
  path by following the README alone.

**Phase 13 exit criterion**: a fresh clone + `docker compose up --build`
matches quickstart §2–§4 without additional setup; TURN opt-in works;
no secrets committed.

---

## Phase 14 — Final verification

**Goal**: prove the MVP meets spec SC-001..SC-009, that every canonical
contract message is used (and none forbidden), that the signaling
server never relays media, and that the README + quickstart remain
accurate.

- [ ] T095 Execute quickstart §4 happy path in two browsers; record pass/fail against SC-001..SC-008 — (no files; produces a verification log pasted into the PR)
- [ ] T096 Execute quickstart §5.1–§5.7 failure paths; record pass/fail against EC-001..EC-013 — (no files)
- [ ] T097 [P] Run `go test ./...` and `npx vitest run`; both must be green — (runs tests)
- [ ] T098 [P] Contract conformance audit: grep the codebase for every message type in contract §3; confirm each appears and each `payload.result` enum value is present — `scripts/check-contract-usage.sh` (or a checklist in PR description)
- [ ] T099 [P] Stale-**message-type** audit (payload values are allowed; only the forbidden names as message types are illegal) — (no files)
- [ ] T100 [P] Media-relay audit: signaling server must never import or call anything that touches SDP / ICE payload strings beyond `Decode` + forward; confirm by reading `internal/signaling/handler.go` + grep for `.SDP`, `.Candidate` outside `messages.go` validators — (no files)
- [ ] T101 [P] NFR-003 log audit: run the server under load for 60 s and grep the logs for `sdp`, `candidate:`, `credential` substrings — must be zero hits — (no files)
- [ ] T102 README + quickstart polish: every link resolves; every step executed in T095/T096 is still accurate — `README.md`, `specs/001-webrtc-1to1-call/quickstart.md`

### T095
- **Phase**: 14 — Final verification
- **Purpose**: Prove the happy path in real browsers.
- **Files**: none (a verification log pasted into the PR).
- **Dependencies**: T094.
- **Parallelizable**: no.
- **Definition of Done**: each of SC-001..SC-008 is marked pass with
  an observation; event log screenshots attached.
- **Verification**: the PR reviewer repeats the walkthrough and
  reaches the same conclusions.

### T096
- **Phase**: 14
- **Purpose**: Prove the failure paths.
- **Files**: none.
- **Dependencies**: T094.
- **Parallelizable**: no (same browser session as T095).
- **Definition of Done**: each of EC-001..EC-013 is marked pass;
  SC-009 timed at ≤ 10 s.
- **Verification**: reviewer re-runs at least EC-004, EC-009, EC-010,
  EC-012.

### T097
- **Phase**: 14
- **Purpose**: Final test-suite sanity check.
- **Files**: none.
- **Dependencies**: all prior phases.
- **Parallelizable**: yes (the two suites are independent).
- **Definition of Done**: both commands exit 0.
- **Verification**: CI log attached to the PR.

### T098
- **Phase**: 14
- **Purpose**: Enforce contract §6 conformance.
- **Files**: `scripts/check-contract-usage.sh` (optional; a manual
  checklist is also acceptable).
- **Dependencies**: T014, T043.
- **Parallelizable**: yes.
- **Definition of Done**: every `type` enum string from contract §3
  appears in both `frontend/src/signaling/schema.ts` and
  `signaling/internal/signaling/messages.go`; every
  `payload.result` enum value from §3.3 and §3.13 appears in both
  codebases.
- **Verification**: script / checklist output attached to PR.

### T099
- **Phase**: 14
- **Purpose**: No stale names leak into production code **as message
  types**. Some of these strings are legitimate payload values
  (contract §3.3 / §3.13) and MUST NOT be blanket-banned; only their
  use as envelope `type` values is forbidden.
- **Files**: none.
- **Dependencies**: all prior phases.
- **Parallelizable**: yes.
- **Definition of Done**: verified by inspection:
  - **Forbidden as message types (zero occurrences expected)**:
    no schema named `roomFullSchema` / `peerJoinedSchema` /
    `peerStateChangedSchema` / `participantReleasedMediaFailedSchema`;
    no Go `TypeRoomFull` / `TypePeerJoined` / `TypePeerStateChanged`
    / `TypeParticipantReleasedMediaFailed` constant; no `Type` enum
    value `"room_full"` / `"peer_joined"` / `"peer_state_changed"`;
    no handler branch on `envelope.type == "room_full"` (etc.); no
    Zod `z.literal("room_full")` used in a `type` discriminator.
  - **Allowed as payload values (expected to appear)**:
    `join_rejected.payload.reason == "room_full"`,
    `join_rejected.payload.result == "join_rejected_room_full"`,
    `participant_released.payload.result ==
    "participant_released_media_failed"`. These MUST appear in
    the `JoinResult` enum / `JoinRejected` / `ParticipantReleased`
    types on both sides.
  - `peer_joined` and `peer_state_changed` should have **zero**
    hits anywhere except in `specs/` documentation that explicitly
    explains "this is not a message type".
- **Verification**: run `rg -n "\"room_full\"|\"peer_joined\"|\"peer_state_changed\"|\"participant_released_media_failed\"" frontend/src signaling/`
  and eyeball each hit against the allow-list above; attach the
  annotated output to the PR.

### T100
- **Phase**: 14
- **Purpose**: Enforce Principle III — signaling server does not
  participate in media.
- **Files**: none.
- **Dependencies**: all server phases.
- **Parallelizable**: yes.
- **Definition of Done**: server relays `offer` / `answer` /
  `ice_candidate` / `media_state` byte-for-byte (only setting
  `from`); never calls anything from a media library; `grep -R
  'pion\|webrtc' signaling/` returns zero hits.
- **Verification**: reviewer reads `handler.go` and confirms.

### T101
- **Phase**: 14
- **Purpose**: Enforce NFR-003 — no SDP / ICE / TURN-credential
  content in logs.
- **Files**: none.
- **Dependencies**: T019, T090.
- **Parallelizable**: yes.
- **Definition of Done**: `docker compose logs signaling | grep -Ei
  'sdp|candidate:|credential'` returns zero hits after a full
  quickstart §4 + §5 run.
- **Verification**: grep output attached.

### T102
- **Phase**: 14
- **Purpose**: Docs drift kills learning projects — final polish.
- **Files**: `README.md`,
  `specs/001-webrtc-1to1-call/quickstart.md`.
- **Dependencies**: T095, T096.
- **Parallelizable**: no (docs edit).
- **Definition of Done**: every link resolves; every step actually
  executed in T095/T096 matches the text.
- **Verification**: final PR diff review.

**Phase 14 exit criterion**: the PR description carries a signed
checklist of SC-001..SC-009, EC-001..EC-013, contract §6 conformance,
and the three audits (stale names, media relay, log hygiene).

---

## Dependency summary by phase

```
Phase 0 ─┐
         ├─► Phase 1 ─► Phase 2 ─► Phase 3 ─► Phase 4 ─► Phase 5 ─► Phase 6 ─► Phase 7 ─► Phase 8
Phase 0 ─┘                                                                                   │
                                                                                             ├─► Phase 9
                                                                                             ├─► Phase 10
                                                                                             └─► Phase 11
                                                                                                   │
                                                                                                   ▼
                                                                                              Phase 12
                                                                                                   │
                                                                                                   ▼
                                                                                              Phase 13
                                                                                                   │
                                                                                                   ▼
                                                                                              Phase 14
```

- **Phase 0**: foundation; T002, T003, T007 can run in parallel with
  the sequential T004/T005/T006 chain.
- **Phase 1**: depends only on Phase 0. TS-side (T008–T011) and
  Go-side (T012–T014) are two sequential sub-chains but the two
  chains can run in parallel with each other.
- **Phase 2**: depends on Phase 1 (envelope decoder). Server-only.
- **Phase 3**: depends on Phase 2 + the contract (T013). Server-only.
- **Phase 4**: depends on Phase 3 only. **Includes T034A (stateful
  relay helpers) and T034B (`offer` / `answer` relay)** — these land
  the server side of the Phase 7 negotiation and unblock it.
- **Phase 5**: depends on Phase 1 (schemas/types) + Phase 2 (WS
  server). Frontend-only.
- **Phase 6**: depends on Phase 5.
- **Phase 7**: depends on Phase 6 + Phase 4 **including T034A/T034B**
  (offer/answer relay must already be live on the server). The
  stateful validators live in the handler, not in `messages.go` —
  so the Phase 4 server ordering is a hard ordering.
- **Phase 8**: depends on Phase 7 + **T063A** (`ice_candidate` server
  relay). T063A uses the T034A helpers; payload-shape validation is
  still T013 in `messages.go`, but the room-state check is T034A.
- **Phase 9**: depends on Phase 8. DataChannel traffic is P2P and
  does not need a new server relay task.
- **Phase 10**: depends on Phase 8 + **T074A** (`media_state` server
  relay).
- **Phase 11**: depends on Phase 10 (re-uses `media_state` relay for
  `screenShare` transitions — no extra relay task needed).
- **Phases 9, 10, 11**: after their server-side prerequisites
  (T063A, T074A) land, they touch different parts of `webrtc/` and
  may run **in parallel** across two or three developers (plan
  §Phase sequencing).
- **Phase 12**: depends on Phases 9–11 joining back in; also on
  Phase 4 server cleanup. Has both client-only and server-only tasks
  that **can** run in parallel (T080–T084 vs T085; test tasks T086,
  T087 are parallelizable).
- **Phase 13**: depends on Phase 12 for the full env var surface.
- **Phase 14**: depends on everything.

### Parallelism cheatsheet (within phases)

| Phase | Can run in parallel |
|---|---|
| 0 | T002, T003, T007 alongside T004 / T005 chain |
| 1 | TS chain (T008→T009→T011) in parallel with Go chain (T012→T013→T014); T010 after T008/T009; T011 and T014 at the end |
| 2 | T016, T020 alongside T015/T017/T018/T019 |
| 3 | T027 alongside T021–T026; T028 waits for T024–T026 |
| 4 | T034 alongside T029–T033 (server-only phase); T034A/T034B run AFTER T031 in sequence |
| 5 | T038, T039, T041, T043 alongside the reducer/client chain |
| 6 | T045, T048, T049 alongside T044/T046/T047 |
| 7 | T055, T056 alongside T050–T054 |
| 8 | T060, T061, T063 alongside T057–T059/T062; T063A is a server task and can run alongside any client Phase 8 task |
| 9 | T067, T068, T069, T070 alongside T064–T066 |
| 10 | T074 alongside T071–T073; T074A is a server task and can run alongside them |
| 11 | T076, T078, T079 alongside T075/T077 |
| 12 | T086, T087 alongside T080–T085; T083 can run alongside T080–T082 |
| 13 | T089, T091 alongside T088/T090/T092/T093; T094 last |
| 14 | T097–T101 all in parallel; T095/T096 paired; T102 last |

---

## Recommended first `/speckit.implement` batch (Phase 0 → Phase 3)

This batch delivers a runnable, contract-validated, room-aware
signaling server with passing tests. It is the first invocation
scope.

**Stepwise plan**:

1. **Phase 0 foundation** — T001 → (T002, T003, T007 in parallel) →
   T004 → T005 → T006. End state: `docker compose config` + `docker
   compose build` succeed; README links resolve. Long-running server
   is deferred to Phase 2.
2. **Phase 1 contract** — two parallel chains:
   - TS: T008 → T009 → T010 → T011
   - Go: T012 → T013 → T014
   End state: both test suites green; all 15 canonical messages have
   schemas on both sides and every forbidden name is absent as a
   message type.
3. **Phase 2 baseline server** — T016 (in parallel with T015) → T015
   → T017 → T018 → T019 → T020. End state: `/healthz` + `/ws` +
   5 s Ping / 5 s Pong-timeout + JSON logs.
4. **Phase 3 admission flow** — T021 → T022 → T023 → (T024 → T025 →
   T026) + T027 in parallel + T028 after T024–T026. End state: two
   WS clients can join a room, a third gets `join_rejected_room_full`,
   pre-pairing departures follow the `peer_presence_changed`-always /
   `peer_left`-never rule. (In-call departure tests are deferred to
   T034B / T086.)

After this batch: sign off against contract §6 for the subset of
messages implemented so far (`join_room`, `join_accepted`,
`join_rejected`, `peer_presence_changed`, `leave_room`,
`peer_left` for the pre-pairing "not fired" case, `error`) and
start the Phase 4+ batch.

---

## Do not proceed to Phase 4+ until the batch above is complete

**Gate**: the following tasks MUST be complete and verified before a
second `/speckit.implement` invocation scoped to Phase 4+:

- **Phase 0**: T001–T007.
- **Phase 1**: T008–T014. Reason: every later phase consumes the
  schema types + canonical names; contract drift compounds.
- **Phase 2**: T015–T020. Reason: Phase 3 handler code relies on the
  WS lifecycle + heartbeat timing already being correct.
- **Phase 3**: T021–T028. Reason: Phase 4 split-state validators
  (contract §§3.8–3.11) are layered on top of `Room` + `Participant`
  state.

After the gate passes, the second `/speckit.implement` run can
proceed through Phases 4 → 14. Within Phase 4 the new relay tasks
(**T034A** stateful helpers → **T034B** offer/answer relay) unblock
Phase 7 on the frontend. **T063A** (`ice_candidate` relay) is required
before Phase 8 frontend work starts; **T074A** (`media_state` relay)
is required before Phase 10 frontend work starts. Phases 9, 10, 11
may be parallelized across team members (different parts of
`webrtc/` + different relay types); all other phases MUST run in
sequence.

---

## Notes

- `[P]` tasks must not modify the same file as another in-flight task;
  when in doubt, serialize.
- Every task has a Definition of Done and a Verification method above;
  a task is not complete until both succeed.
- Tests belong to the phase that produces the behavior they test,
  not to a separate "test phase".
- No phase may add a canonical message name beyond the 15 in
  `contracts/signaling-protocol.md` §3. Reviving `room_full`,
  `peer_joined`, `peer_state_changed`, or
  `participant_released_media_failed` as a message type is forbidden.
- Signaling server must never touch media (Principle III) — guarded
  by T100.
- Signaling logs must never contain SDP / ICE / TURN credentials
  (NFR-003) — guarded by T101.
- For manual verification of UI-driven behavior, follow
  `specs/001-webrtc-1to1-call/quickstart.md` exactly.
