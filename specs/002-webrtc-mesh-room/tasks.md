# Tasks: Multi-party Mesh WebRTC Learning Room

**Branch**: `002-webrtc-mesh-room` | **Date**: 2026-04-25
**Plan**: [plan.md](./plan.md) | **Spec**: [spec.md](./spec.md)
**Contract**: [contracts/signaling-protocol.md](./contracts/signaling-protocol.md)
**Data model**: [data-model.md](./data-model.md) | **Quickstart**: [quickstart.md](./quickstart.md)

## Format

Each task is a one-line markdown checklist row plus a small detail block:

```text
- [ ] T### [P?] [tags] [M#] Short title — file path(s)
    - Purpose: …
    - Files: …
    - Dependencies: …
    - DoD: …
    - Verify: …
```

**Tag legend** (combinable; every task carries the relevant subset):

- `[contract]` — task edits or derives from `contracts/signaling-protocol.md` v2.
- `[server]` — Go signaling work under `signaling/`.
- `[frontend]` — React / TypeScript work under `frontend/`.
- `[webrtc]` — RTCPeerConnection / RTCDataChannel / media tracks.
- `[test]` — automated test work (Vitest, `go test`).
- `[shared-infra]` — touches a surface shared with 001 (route shell, app wrapper, docker-compose, env). MUST pass the 001 regression checklist before merge.
- `[STOP-001-RISK]` — task appears to mutate 001-owned behavior or v1 contract. **No normal task should require this tag.** If you find yourself reaching for it, stop and re-read plan §6 Preservation Boundary.
- `[P]` — parallelizable (different files AND no incomplete-task dependency).
- `[M#]` — phase tag matching plan §18 (M1..M12) or `[Setup]`, `[Audit]`.

**No SFU. No server-side media. No 001 mutation. No `screen_share_busy`. No bare `room_full` envelope type. No signaling-relayed final chat. No global chat ordering claim. No ICE restart proper.**
(Spec Non-Goals + plan §6 + plan §10.7 + plan §16.4 / FR-055.)

---

## 0. Pre-flight

These dependency relationships are referenced throughout the task list.
Read once before starting any phase.

### 0.1 Phase dependency summary

```
Setup → M1 ──▶ M2 ──▶ M3 ──▶ M4 ──▶ M5 ──▶ M6 ──▶ M7
                                                  │
                                          ┌───────┴───────┐
                                          ▼               ▼
                                          M8              M9
                                          │               │
                                          │               ▼
                                          │              M10
                                          ▼               │
                                          M11 ◀───────────┘
                                          │
                                          ▼
                                          M12 ──▶ Audit
```

- **Setup → M1 → M2 → M3 → M4 → M5 → M6 → M7** is strictly sequential (foundation).
- After **M7**, **M8** (DataChannel chat) and **M9** (media controls / server-fan-out) can be pursued in parallel by two contributors. **M10** (screen share) depends on M9.
- **M11** depends on **M7** (per-pair PC lifecycle). It can land after either M8 or M10; it does not depend on the parallel branch's siblings.
- **M12** is the final integration + 001 regression and depends on every preceding phase.
- **Audit** is run last and depends on M12.

### 0.2 Recommended first implementation batch

Tasks that are safe to start in parallel as the very first wave (no
dependencies on incomplete tasks):

- T001, T002, T003, T004 (Setup — `[P]` between themselves except T002 depends on T001).

The single best first task is **T001** (add `react-router-dom`), since
it unblocks the route shell and the rest of M1.

### 0.3 Gating checklists

Tasks that **MUST be complete** before each pivotal point:

| Gate | Required tasks |
|---|---|
| Before any RTCPeerConnection code (M6+) | All of M1, M2, M3, M4, M5; specifically T027 + T028 (server-side roster + admission), T039 + T044 (frontend two-phase join end-to-end), and T030 (admission tests incl. `TestAdmissionIndexNeverReused`) green. |
| Before DataChannel chat work (M8) | All of M1–M7. M7 must reach SC-001 (4-browser mesh call) on a manual run. |
| Before `reconnect_pair` work (M11) | All of M6 (pairEpoch infrastructure) and M7 (per-pair indicators); M7's contract tests for `pairEpoch` (T053) must be green. |
| Before `/speckit.implement` is invoked | **No implementation task must be complete.** The workflow consumes this `tasks.md` and starts at T001; it MUST follow the §0.1 phase DAG (no skipping ahead). The recommended first batch to execute is Setup + M1 + M2 + M3; do not proceed to M4+ until M1–M3 verification is green. |
| Before M12 final verification | All of M1–M11 green; quickstart §4.2–§4.6 reproducible by a fresh contributor following the doc. |

---

## Phase Setup — Project initialization (shared infrastructure, M1 prereq)

- [X] T001 [shared-infra][frontend] [Setup] Add `react-router-dom` (^6) to `frontend/package.json` — `frontend/package.json`, `frontend/package-lock.json`
    - Purpose: enable the `/` (001) vs `/mesh/:roomId` (002) route boundary; the only top-level frontend dependency added by 002.
    - Files: `frontend/package.json`, `frontend/package-lock.json`.
    - Dependencies: none.
    - DoD: `npm install` (or `npm ci` after lockfile commit) inside `frontend/` succeeds; `react-router-dom` appears in `dependencies`; no other dependency was added or removed; 001 build still succeeds (`npm run build`).
    - Verify: `cd frontend && npm install && npm run build` → exit 0; `git diff` shows only `package.json` + `package-lock.json` touched.

- [X] T002 [P] [shared-infra][frontend] [Setup] Create mesh feature directory skeleton — `frontend/src/features/mesh/{routes,components,signaling,state,webrtc,tests}/.gitkeep`
    - Purpose: reserve the feature-scoped subtree per plan §5.2 so subsequent tasks don't need to invent paths.
    - Files: `.gitkeep` files at each subdir; `frontend/src/routes/.gitkeep` for the top-level route shell home.
    - Dependencies: none (no `[P]` block on T001 — different files).
    - DoD: `git status` shows the seven new empty paths; nothing else.
    - Verify: `find frontend/src/features/mesh -type d` lists the six subdirs.

- [X] T003 [P] [shared-infra][server] [Setup] Create mesh server package skeleton — `signaling/internal/mesh/.gitkeep`
    - Purpose: reserve the server feature-scoped subtree.
    - Files: `signaling/internal/mesh/.gitkeep`; `signaling/tests/mesh/.gitkeep` for mesh-only test suite.
    - Dependencies: none.
    - DoD: paths exist on disk.
    - Verify: `ls signaling/internal/mesh signaling/tests/mesh`.

- [X] T004 [P] [shared-infra] [Setup] Confirm docker-compose still supports mesh dev — `docker-compose.yml`
    - Purpose: verify no compose-level change is required for `/ws/mesh` (the same `signaling` service hosts both endpoints; same port 8080); document this decision in a comment.
    - Files: `docker-compose.yml` (comment-only edit, optional).
    - Dependencies: none.
    - DoD: `docker compose up --build` brings 001 up unchanged; comment explains "mesh endpoint is registered in cmd/signaling/main.go on the same listener — no extra service needed."
    - Verify: `docker compose up --build` then `curl http://localhost:8080/healthz` → `{"status":"ok"}`; visit `http://localhost:5173/` → 001 unchanged.

---

## Phase M1 — Route shell and `/ws/mesh` endpoint

**Goal**: `/` still loads 001 unchanged; `/mesh/:roomId` renders a placeholder shell with the mode badge; `/ws/mesh` accepts and logs WS connect/disconnect. No mesh logic yet.

- [X] T005 [shared-infra][frontend] [M1] Wrap `App.tsx` in `<BrowserRouter>` with two routes — `frontend/src/App.tsx`, `frontend/src/main.tsx`, `frontend/src/routes/index.tsx`
    - Purpose: install the route boundary; `/` continues to render the existing 001 component tree byte-for-byte; `/mesh/:roomId` renders a placeholder.
    - Files: `frontend/src/App.tsx` (wrap), `frontend/src/routes/index.tsx` (new — declares the two routes).
    - Dependencies: T001, T002.
    - DoD: visiting `/` renders the existing 001 layout exactly as before T001 (manual diff); visiting `/mesh/demo` renders the placeholder.
    - Verify: 001 quickstart `§4.1` (room entry) passes unchanged; `/mesh/demo` shows the placeholder.

- [X] T006 [P] [shared-infra][frontend] [M1] Add persistent ModeBadge — `frontend/src/routes/modeBadge.tsx`
    - Purpose: FR-004 mesh-mode UI indicator; shows "Mesh mode (capacity 4)" on `/mesh/*` and "1:1 mode" on `/`. Persistent in the header for the entire session.
    - Files: `frontend/src/routes/modeBadge.tsx` (new).
    - Dependencies: T005 (routes must exist).
    - DoD: header badge text differs visibly between `/` and `/mesh/demo`; both badges remain visible during navigation between lobby and in-room views.
    - Verify: manual visit to `/` and `/mesh/demo`; screenshot diff or eyeballed badge.

- [X] T007 [frontend] [M1] Stub `MeshApp.tsx` placeholder — `frontend/src/features/mesh/routes/MeshApp.tsx`
    - Purpose: this is the eventual mesh page; in M1 it is a placeholder rendering "Mesh mode (capacity 4) — placeholder". Replaced by real UI in M4.
    - Files: `frontend/src/features/mesh/routes/MeshApp.tsx` (new).
    - Dependencies: T002, T005.
    - DoD: `MeshApp` is the route component for `/mesh/:roomId`; renders the placeholder text and reads `:roomId` from the URL params.
    - Verify: navigate to `/mesh/abc123`; placeholder text shows the room ID.

- [X] T008 [server] [M1] Register `/ws/mesh` next to `/ws` in `cmd/signaling/main.go` — `signaling/cmd/signaling/main.go`, `signaling/internal/mesh/handler.go`
    - Purpose: add the mesh WebSocket endpoint. The 001 `/ws` registration is left untouched (plan §6.4).
    - Files: `signaling/cmd/signaling/main.go` (one new `mux.Handle("/ws/mesh", meshHandler)` line), `signaling/internal/mesh/handler.go` (new — minimal upgrader + log on connect/disconnect; no message logic yet).
    - Dependencies: T003.
    - DoD: server logs `mesh_ws_connected` / `mesh_ws_disconnected` with a per-conn correlation ID; `wscat -c ws://localhost:8080/ws/mesh` connects.
    - Verify: `docker compose up --build`; in another terminal `wscat -c ws://localhost:8080/ws/mesh`; observe logs.

- [X] T009 [P] [test][server] [M1] Smoke test for `/ws/mesh` connect — `signaling/tests/mesh/handler_smoke_test.go`
    - Purpose: assert mesh handler upgrades WS without 001 regression.
    - Files: `signaling/tests/mesh/handler_smoke_test.go` (new).
    - Dependencies: T008.
    - DoD: in-process WS connect to `/ws/mesh` succeeds; an idempotent test using `httptest` + `coder/websocket`'s test helpers.
    - Verify: `cd signaling && go test ./tests/mesh/...` → PASS; `go test ./...` shows no 001 failures.

- [X] T010 [test] [M1] 001 smoke regression after route shell — manual + CI
    - Purpose: confirm 001 quickstart `§4.1` (room entry, two browsers, lifecycle event log appears) passes after T005..T008.
    - Files: none — execution-only checklist on the existing 001 quickstart.
    - Dependencies: T005, T008.
    - DoD: every box in 001 `quickstart.md §4.1` checked manually OR a CI smoke test (Playwright if configured) green.
    - Verify: 001 join → media → connected sequence works; event log shows the 001 lifecycle entries unchanged.

---

## Phase M2 — Mesh v2 signaling contract: validators + tests

**Goal**: every v2 message type defined in `contracts/signaling-protocol.md §3` has a Go validator and a Zod schema; both round-trip the contract examples; **no ad-hoc JSON** sent or accepted; **no bare `room_full`**, **no `screen_share_busy`**, **no signaling-relayed final chat** pathways exist in the schema.

> **Source of truth**: `contracts/signaling-protocol.md` v2. If a task seems to require a contract change, stop and amend the contract first.

- [X] T011 [contract][server] [M2] Implement v2 envelope + version guard in Go — `signaling/internal/mesh/protocol.go`
    - Purpose: parse the envelope (`v`, `type`, `roomId`, `from`, `to`, `requestId`, `ts`, `payload`); reject `v != 2` with `error { code: "unsupported_version" }` and any unknown `type` with `error { code: "malformed" }`.
    - Files: `signaling/internal/mesh/protocol.go` (new).
    - Dependencies: T008.
    - DoD: helper functions `DecodeEnvelope`, `EncodeEnvelope`, `Validate(t MessageType, payload Raw) error` exist; rejection cases return typed `ProtocolError` matching contract §3.19.
    - Verify: unit test `protocol_envelope_test.go` covers `v=1`, `v=3`, unknown `type`, missing required fields; all reject correctly.

- [X] T011a [P] [test][server] [M2] Acceptance — `unsupported_version` on `/ws/mesh` — `signaling/tests/mesh/protocol_unsupported_version_test.go`
    - Purpose: contract §3.19 — assert that any inbound message on `/ws/mesh` with `v != 2` triggers `error { code: "unsupported_version" }` and produces NO room/state mutation. Closes analyze report C9; standardizes the version-mismatch path on the protocol-level `error` channel (not on `join_rejected`).
    - Files: `signaling/tests/mesh/protocol_unsupported_version_test.go` (new).
    - Dependencies: T011.
    - DoD: scenarios covered — (1) `join_room` with `v=1`; (2) `join_room` with `v=3`; (3) `pair_offer` with `v=1`; in each case the server replies with `error { code: "unsupported_version" }`, the inbound is NOT relayed, and `MeshRoomManager` snapshots before/after are byte-equal (no mutation).
    - Verify: `go test ./tests/mesh/protocol_unsupported_version_test.go` → PASS.

- [X] T012 [P] [contract][frontend] [M2] Author Zod envelope schema — `frontend/src/features/mesh/signaling/schema.ts`
    - Purpose: TypeScript-side discriminated union over all v2 types; mirrors §3 of the contract.
    - Files: `frontend/src/features/mesh/signaling/schema.ts` (new).
    - Dependencies: T002.
    - DoD: `MeshClientMessage` and `MeshServerMessage` discriminated unions exported; envelope guard rejects `v != 2`.
    - Verify: `npx tsc --noEmit` clean; sample fixtures in `tests/` parse.

- [X] T013 [contract][server][P] [M2] Go structs + validators for admission family — `signaling/internal/mesh/protocol.go`
    - Purpose: `join_room`, `join_accepted`, `join_rejected`, `participant_released`, `peer_left`, `leave_room` (contract §3.1, §3.2, §3.3, §3.8, §3.17, §3.18).
    - Files: `signaling/internal/mesh/protocol.go` (extend).
    - Dependencies: T011.
    - DoD: each type's `validate()` rejects malformed payload; `join_rejected.payload.result` enforces `{join_rejected_room_full | join_rejected_invalid_room}` (version mismatch is NOT a `join_rejected` result — it is delivered as `error { code: "unsupported_version" }`, see contract §3.3 + §3.19 + T011a). **Bare `room_full` envelope type does NOT exist.**
    - Verify: `protocol_admission_test.go` round-trips contract §3.1–§3.3 examples; assertion that `room_full` is not a registered `MessageType`; assertion that `join_rejected_unsupported_version` is NOT a valid `result` enum value.

- [X] T014 [contract][server][P] [M2] Go structs + validators for roster family — `signaling/internal/mesh/protocol.go`
    - Purpose: `mesh_roster_snapshot`, `mesh_roster_update` (contract §3.4–§3.5).
    - Files: `signaling/internal/mesh/protocol.go` (extend).
    - Dependencies: T011.
    - DoD: `presence` enum is exactly the 7-element set from FR-013 (`joined | media-ready | connecting | connected | failed | released | left`); `serverSeq` monotonicity is enforced by the manager (§M3), not the validator, but the schema requires `serverSeq` present.
    - Verify: round-trip test for §3.4 / §3.5 examples; rejection for invalid `presence`.

- [X] T015 [contract][server][P] [M2] Go structs + validators for media-readiness family — `signaling/internal/mesh/protocol.go`
    - Purpose: `media_ready`, `media_failed` (contract §3.6, §3.7).
    - Files: `signaling/internal/mesh/protocol.go` (extend).
    - Dependencies: T011.
    - DoD: `media_ready.payload.mediaCapabilities` requires both `audio:true` and `video:true`; rejection ⇒ `error unsupported_media_capability`.
    - Verify: round-trip test; rejection for `audio:false`.

- [X] T016 [contract][server] [M2] Go structs + validators for pair family — `signaling/internal/mesh/protocol.go`
    - Purpose: `pair_negotiation_instruction`, `pair_offer`, `pair_answer`, `pair_ice_candidate`, `pair_media_state`, `pair_failed`, `reconnect_pair`, `pair_reconnect_instruction` (contract §3.9–§3.16).
    - Files: `signaling/internal/mesh/protocol.go` (extend).
    - Dependencies: T011, T014.
    - DoD: every pairwise type carries `pairId` AND `pairEpoch` in `payload` (validator rejects missing); `pair_ice_candidate` rejects `candidate: ""` as `malformed` while accepting `candidate: null` (end-of-candidates); `pair_media_state` requires all three of `microphone`/`camera`/`screenShare` and does NOT carry `pairId` per §3.13 note.
    - Verify: `protocol_pair_test.go` round-trips contract §3.9–§3.16 examples; rejection cases for missing `pairEpoch`, `candidate:""`, partial `pair_media_state`.

- [X] T017 [contract][server] [M2] Go error types + codes — `signaling/internal/mesh/protocol.go`
    - Purpose: implement the §3.19 error code enum; centralize `ProtocolError` construction.
    - Files: `signaling/internal/mesh/protocol.go` (extend).
    - Dependencies: T011.
    - DoD: codes match the table in §3.19 exactly; **`room_full` and `invalid_room_id` are NOT codes** — pre-admission rejection uses `join_rejected.result`; **`screen_share_busy` is NOT a code**.
    - Verify: unit test asserts the code-set equality with the spec table; assertion that the error-code constant for `screen_share_busy` does not exist (compile-time guarantee).

- [X] T018 [P] [contract][frontend] [M2] Zod schemas for admission + roster families — `frontend/src/features/mesh/signaling/schema.ts`
    - Purpose: client-side counterparts to T013 + T014.
    - Files: `frontend/src/features/mesh/signaling/schema.ts` (extend).
    - Dependencies: T012.
    - DoD: `JoinAcceptedSchema`, `JoinRejectedSchema`, `MeshRosterSnapshotSchema`, `MeshRosterUpdateSchema`, `ParticipantReleasedSchema`, `PeerLeftSchema`, `LeaveRoomSchema` exported; presence enum hard-coded to the 7-element set.
    - Verify: round-trip Vitest spec.

- [X] T019 [P] [contract][frontend] [M2] Zod schemas for media + pair families — `frontend/src/features/mesh/signaling/schema.ts`
    - Purpose: client-side counterparts to T015 + T016.
    - Files: `frontend/src/features/mesh/signaling/schema.ts` (extend).
    - Dependencies: T012, T018.
    - DoD: pair schemas require `pairId` + `pairEpoch`; `pair_ice_candidate` rejects `candidate:""`; `pair_media_state` requires the full triple.
    - Verify: Vitest spec parses examples; rejection cases tested.

- [X] T020 [test][server] [M2] Server-side stale-message rejection unit test — `signaling/tests/mesh/protocol_pair_epoch_test.go`
    - Purpose: assert that an inbound pair message with `payload.pairEpoch < server.currentEpoch[pairId]` returns `error stale_pair_epoch` and is NOT forwarded.
    - Files: new test file.
    - Dependencies: T016, T017.
    - DoD: the test installs a fake current epoch, sends a pair message with a lower epoch, and asserts the validator returns `ProtocolError{Code: "stale_pair_epoch"}`. Forwarding side-effect is asserted via a fake relay sink (no message delivered).
    - Verify: `go test ./tests/mesh/protocol_pair_epoch_test.go` → PASS.

- [X] T021 [test][frontend] [M2] Client-side contract round-trip + invariant test — `frontend/src/features/mesh/tests/contract.spec.ts`
    - Purpose: assert all v2 examples from `contracts/signaling-protocol.md §3` parse; assert specific invariants (no bare `room_full` type, no `screen_share_busy` type, presence enum is exactly the 7-element set, every pair message requires `pairEpoch`).
    - Files: `frontend/src/features/mesh/tests/contract.spec.ts` (new).
    - Dependencies: T012, T018, T019.
    - DoD: at least one positive case per type; explicit negative tests asserting `room_full` and `screen_share_busy` are not in the message-type union.
    - Verify: `cd frontend && npx vitest run features/mesh/tests/contract.spec.ts` → PASS.

- [X] T022 [test][server] [M2] Audit test — no signaling-relayed final chat surface — `signaling/tests/mesh/no_signaling_chat_test.go`
    - Purpose: enforce FR-053 final-MVP transport rule at the contract level: no `chat_message` (or equivalent) message type exists in v2.
    - Files: new test file.
    - Dependencies: T013–T017.
    - DoD: test introspects the registered `MessageType` set and asserts no chat-bearing type. Comment notes that group chat traverses RTCDataChannel only (M8).
    - Verify: `go test ./tests/mesh/no_signaling_chat_test.go` → PASS.

---

## Phase M3 — Mesh room manager + roster + 4-cap + 5th rejection

**Goal**: server admits up to 4 participants per room; emits `mesh_roster_snapshot` exactly once at admission; emits ordered `mesh_roster_update` on every readiness change; 5th `join_room` is rejected with `join_rejected { result: "join_rejected_room_full" }` within 2 s; `admission_index` is monotonic and never reused; server **never** relays media.

- [X] T023 [server] [M3] Implement `MeshRoomManager` registry — `signaling/internal/mesh/manager.go`
    - Purpose: top-level concurrent-safe registry of mesh rooms keyed by `roomId`; mirrors data-model §A.1.
    - Files: `signaling/internal/mesh/manager.go` (new).
    - Dependencies: T011.
    - DoD: `JoinOrCreate`, `Leave`, `LookupBySocket` exposed; per-room `sync.Mutex` consistently held during state mutations.
    - Verify: `manager_test.go` covers create-on-first-join + lookup.

- [X] T024 [server] [M3] Implement `MeshRoom` capacity + reserved slots — `signaling/internal/mesh/room.go`
    - Purpose: 4-element `[4]ReservedSlot`; allocate-on-admit; `admissionCounter` monotonic and **never** reused (data-model §A.2 / research §5).
    - Files: `signaling/internal/mesh/room.go` (new).
    - Dependencies: T023.
    - DoD: `MeshRoom.Admit` returns `ErrRoomFull` when 4 slots reserved; index is `++admissionCounter`; freeing a slot via `OnLeave` keeps `admissionCounter` strictly monotonic (the freed slot's index is NOT recycled). Reconnect / pair-epoch correctness depends on this invariant — see T030 sub-tests `TestAdmissionIndexNeverReused` + `TestPairIdUsesAdmissionIndexNotSlotIndex`.
    - Verify: `mesh_admission_test.go` (T030) green.

- [X] T025 [server] [M3] Implement `Participant` FSM — `signaling/internal/mesh/participant.go`
    - Purpose: `joined → media-ready → left` plus side-exit `joined → released` (data-model §A.3).
    - Files: `signaling/internal/mesh/participant.go` (new).
    - Dependencies: T024.
    - DoD: enforce only valid transitions; reject `media_ready` from non-`joined` (`error unexpected_media_ready`); `released` is terminal pre-pairing.
    - Verify: `participant_fsm_test.go` covers all transitions including invalid ones.

- [X] T026 [server] [M3] Implement `Pair` + `PairId` + `pairEpoch` ledger — `signaling/internal/mesh/pair.go`
    - Purpose: per-pair state machine and the server-canonical epoch counter (data-model §A.4–§A.5).
    - Files: `signaling/internal/mesh/pair.go` (new).
    - Dependencies: T024.
    - DoD: `PairId` derived from sorted `(loIdx, hiIdx)` as `"<lo>-<hi>"`; `pairEpoch[pairId]` initialized to `1` at first eligibility, increments by `+1` on each `OnReconnectPair`; per-`PairId` mutex serializes reconnect races.
    - Verify: `pair_epoch_test.go` (later) green.

- [X] T027 [server] [M3] Roster snapshot on admission + ordered updates — `signaling/internal/mesh/roster.go`
    - Purpose: implement `EmitRosterSnapshot` and `BroadcastRosterUpdate` per FR-012a / FR-012b; bumps `MeshRoom.rosterSeq`.
    - Files: `signaling/internal/mesh/roster.go` (new).
    - Dependencies: T023, T024, T025.
    - DoD: snapshot includes all current participants (incl. the newly-admitted self); updates carry strictly-increasing `serverSeq`; broadcast targets every participant including the subject (data-model §A.6).
    - Verify: `mesh_roster_test.go` (T030).

- [X] T028 [server] [M3] Mesh handler — wire admission + leave to /ws/mesh — `signaling/internal/mesh/handler.go`
    - Purpose: replace the M1 placeholder handler with the real read-loop that parses envelopes (T011), routes to the manager (T023), and emits `join_accepted` + `mesh_roster_snapshot` + first `mesh_roster_update`.
    - Files: `signaling/internal/mesh/handler.go` (extend; replaces M1 stub).
    - Dependencies: T008, T011, T013, T014, T023, T027.
    - DoD: 1st–4th `join_room` succeed; 5th gets `join_rejected { result: "join_rejected_room_full" }`; `leave_room` releases the slot and broadcasts `mesh_roster_update { presence: "left" }` (the M5 / M11 paths add the convenience `peer_left` for in-call departures).
    - Verify: `mesh_admission_test.go`.

- [X] T029 [server] [M3] Heartbeat / disconnect detection wiring — `signaling/internal/mesh/heartbeat.go`
    - Purpose: 5 s ping + 5 s pong-timeout (≤10 s detection — SC-005a); identical timing constants to 001.
    - Files: `signaling/internal/mesh/heartbeat.go` (new); env wiring in `cmd/signaling/main.go`.
    - Dependencies: T008, T028.
    - DoD: a hung WS triggers slot release + roster update within 10 s; environment vars `PING_INTERVAL_MS` / `PONG_TIMEOUT_MS` honored (default 5000 each).
    - Verify: `heartbeat_test.go` simulates a missed pong and asserts cleanup runs within the bound.

- [X] T030 [test][server] [M3] M3 acceptance — admission + roster + 5th rejection — `signaling/tests/mesh/{mesh_admission,mesh_roster}_test.go`
    - Purpose: protocol-flow tests that 4 WS clients are admitted (each receiving snapshot + the appropriate roster updates), and a 5th gets `join_rejected_room_full` < 2 s. Also lock in the `admissionIndex` non-reuse invariant on which `pairEpoch` / reconnect correctness depends.
    - Files: `signaling/tests/mesh/mesh_admission_test.go`, `mesh_roster_test.go` (new).
    - Dependencies: T024, T027, T028.
    - DoD: tests pass; `mesh_roster_test.go` asserts strictly-increasing `serverSeq` over 6+ updates. `mesh_admission_test.go` additionally contains:
        - `TestAdmissionIndexNeverReused` — A and B join (indices `1`, `2`); A leaves gracefully; C joins; assert `C.admissionIndex > B.admissionIndex` (`= 3`, NOT `1`). Existing pair IDs MUST NOT collide with historical pair IDs from A's session.
        - `TestPairIdUsesAdmissionIndexNotSlotIndex` — induce a freed-then-reused slot scenario; assert `pairId` derivation uses `admissionIndex`, not `slot.index`, so a recycled slot does NOT produce a colliding `pairId`.
    - Verify: `go test ./tests/mesh/...` → PASS, with both new sub-tests green.

---

## Phase M4 — Mesh frontend shell + roster UI + peer-scoped event log

**Goal**: `MeshApp` connects to `/ws/mesh`, joins a room, renders the roster (presence pills), and surfaces a peer-scoped event log. **No `RTCPeerConnection`, no `getUserMedia` yet.**

- [X] T031 [frontend] [M4] Mesh WebSocket client — `frontend/src/features/mesh/signaling/client.ts`
    - Purpose: connect to `/ws/mesh`, send/receive JSON; expose `connect()`, `send()`, `onMessage()`. No auto-reconnect (Spec Non-Goals).
    - Files: `frontend/src/features/mesh/signaling/client.ts` (new).
    - Dependencies: T012, T018, T019.
    - DoD: schema-validated outbound + inbound; `signalingTransport` slice receives transport state; logs transport-level events (`signaling connected`, `signaling disconnected`).
    - Verify: a manual visit to `/mesh/demo` shows event-log entry `signaling connected`; close server → event-log entry `signaling disconnected`.

- [X] T032 [frontend][P] [M4] Mesh dispatcher — `frontend/src/features/mesh/signaling/dispatcher.ts`
    - Purpose: route inbound mesh messages to the correct reducer slice (plan §9.5 mapping).
    - Files: `frontend/src/features/mesh/signaling/dispatcher.ts` (new).
    - Dependencies: T031.
    - DoD: a discriminated switch over `MeshServerMessage["type"]`; default arm logs `error occurred` and does not mutate state.
    - Verify: unit test feeding each message type asserts the correct slice action is dispatched.

- [X] T033 [frontend] [M4] Local participant reducer — `frontend/src/features/mesh/state/local.ts`
    - Purpose: `LocalParticipant` FSM (data-model §B.1); handles `join_accepted`, `join_rejected`, `participant_released`, transitions to `signaling-error` on socket loss.
    - Files: `frontend/src/features/mesh/state/local.ts` (new).
    - Dependencies: T002.
    - DoD: every transition matches data-model §B.1 diagram; invalid inbound transitions are no-op + log entry.
    - Verify: `local.spec.ts` covers each transition incl. `signaling-error`.

- [X] T034 [frontend][P] [M4] Roster reducer — `frontend/src/features/mesh/state/roster.ts`
    - Purpose: applies `mesh_roster_snapshot` and `mesh_roster_update`; enforces `serverSeq` monotonicity; removes participants on `released` / `left`.
    - Files: `frontend/src/features/mesh/state/roster.ts` (new).
    - Dependencies: T002.
    - DoD: out-of-order `serverSeq` is dropped + log entry; snapshot replaces the map; updates upsert.
    - Verify: `roster.spec.ts` ((covered later in T097 audit too)).

- [X] T035 [frontend][P] [M4] Event log reducer (bounded ring buffer) — `frontend/src/features/mesh/state/eventLog.ts`
    - Purpose: data-model §B.6; bounded at 1000 entries; every `peer`-/`pair`-scoped entry must carry `peerId` (and `pairId` for pair scope) per FR-061.
    - Files: `frontend/src/features/mesh/state/eventLog.ts` (new).
    - Dependencies: T002.
    - DoD: append, evict-on-overflow, and selectors for `all | room | peer:<id> | pair:<id>` filters.
    - Verify: `eventLog.spec.ts`.

- [X] T036 [frontend] [M4] `MeshApp.tsx` real layout — `frontend/src/features/mesh/routes/MeshApp.tsx`
    - Purpose: replace the M1 placeholder with the real shell: `JoinForm`, `MeshRoster`, `MeshEventLogPanel`. No PCs / DCs yet.
    - Files: `frontend/src/features/mesh/routes/MeshApp.tsx` (extend), `frontend/src/features/mesh/components/{MeshRoster,MeshEventLogPanel,JoinForm}.tsx` (new).
    - Dependencies: T031, T033, T034, T035.
    - DoD: 4 windows joining `/mesh/demo` see each other in the roster within 1 s; every readiness change appears as a peer-scoped log entry with `peerId` (FR-061).
    - Verify: manual 4-window run; quickstart §4.2 partial green.

- [X] T037 [frontend][P] [M4] Mesh JoinForm — `frontend/src/features/mesh/components/JoinForm.tsx`
    - Purpose: client-side room-ID validation (Spec FR-010 + EC-015) — trim / case-sensitive / 1–64 / `[A-Za-z0-9._-]`.
    - Files: `frontend/src/features/mesh/components/JoinForm.tsx` (new — covered partly by T036; this is the standalone validation logic).
    - Dependencies: T002, T036.
    - DoD: invalid IDs surface a clear error before any signaling message is sent; valid IDs send `join_room`.
    - Verify: `joinForm.spec.ts` covers boundary cases (empty after trim, 65 chars, `bad room!`).

- [X] T038 [test][frontend][P] [M4] M4 acceptance test — `frontend/src/features/mesh/tests/{roster,eventLog,local}.spec.ts`
    - Purpose: assert the M4 reducers (T033/T034/T035) behave per data-model §B; M4 quickstart §4.2 manual run green.
    - Files: 3 spec files (new).
    - Dependencies: T033, T034, T035, T036.
    - DoD: all three spec files green; manual 4-window roster run shows correct presence pills.
    - Verify: `npx vitest run features/mesh/tests/`.

---

## Phase M5 — Two-phase join + media acquisition + readiness updates

**Goal**: each browser acquires camera + mic, sends `media_ready`; on failure sends `media_failed` and surfaces a retry-able UX; server emits the corresponding roster updates (`media-ready` / `released`); **no pair negotiation occurs until `media-ready`**.

- [X] T039 [frontend][webrtc] [M5] Local media acquisition + preview — `frontend/src/features/mesh/webrtc/mediaAcquisition.ts`, `frontend/src/features/mesh/components/LocalPreview.tsx`
    - Purpose: `getUserMedia({ audio: true, video: true })`; render a self-tile preview; transition `LocalParticipant.fsm` to `media-ready` on success or `media-error` on failure.
    - Files: 2 new files.
    - Dependencies: T033, T036.
    - DoD: permission grant ⇒ preview renders + `media_ready` sent; permission denial ⇒ `media_failed` sent + Retry affordance.
    - Verify: quickstart §5.1 / §5.2 manual checks pass.

- [X] T040 [server] [M5] Handle `media_ready` + `media_failed` — `signaling/internal/mesh/handler.go`, `signaling/internal/mesh/room.go`
    - Purpose: server transitions `Participant.readiness` and emits the corresponding roster update; on `media_failed`, also emits `participant_released` to the failing peer.
    - Files: extend handler + room.
    - Dependencies: T015, T028.
    - DoD: `media_ready` → roster update `presence: "media-ready", reason: "media_ready"`; `media_failed` → `participant_released` to the sender + roster update `presence: "released", reason: "media_failed"` to others.
    - Verify: `mesh_media_ready_test.go`, `mesh_media_failed_test.go`.

- [X] T041 [frontend][P] [M5] Roster presence rendering for `released` — `frontend/src/features/mesh/components/MeshRoster.tsx`
    - Purpose: visualize the `released` presence; FR-013/FR-014 distinguish from `left`.
    - Files: extend `MeshRoster.tsx`.
    - Dependencies: T034, T036.
    - DoD: a `released` participant disappears from each other's roster (not just dimmed); local UI shows the persistent media-error banner for the failing self.
    - Verify: manual run with one peer denying permission; remaining peers see no roster entry; failing peer sees Retry banner.

- [X] T042 [P][test][server] [M5] Slot release on `media_failed` — `signaling/tests/mesh/mesh_media_failed_test.go`
    - Purpose: assert server frees the slot and emits the right roster update; `admission_index` is preserved (not reused) per data-model §C.4.
    - Files: new test file.
    - Dependencies: T040.
    - DoD: after `media_failed` from a 4th joiner, a 5th joiner can be admitted (slot is free) AND the 5th's `admission_index` is greater than the failed 4th's (no reuse).
    - Verify: `go test ./tests/mesh/mesh_media_failed_test.go`.

- [X] T043 [P][test][frontend] [M5] Two-phase join readiness reducer test — `frontend/src/features/mesh/tests/twoPhaseJoin.spec.ts`
    - Purpose: assert the local FSM cannot pre-pair (no PC creation requests are emitted while `LocalParticipant.fsm != media-ready`).
    - Files: new spec.
    - Dependencies: T033, T039.
    - DoD: spec exercises the `joining → joined → media-ready` order; if a stub pair instruction were to arrive in `joined`, the dispatcher logs `error occurred` and does not create a PC.
    - Verify: `npx vitest run features/mesh/tests/twoPhaseJoin.spec.ts`.

- [X] T044 [frontend] [M5] Persistent media-error banner + retry — `frontend/src/features/mesh/components/MediaErrorBanner.tsx`
    - Purpose: SC clarity for EC-003 post-admission case; user sees a visible banner with Retry that re-invokes `getUserMedia` and re-issues `media_ready` on success.
    - Files: new component; small extension to `MeshApp.tsx`.
    - Dependencies: T039, T041.
    - DoD: rejecting permission, then granting on retry, lands the user in `media-ready` without a full page reload.
    - Verify: quickstart §5.2 manual.

---

## Phase M6 — Pairwise negotiation: `pair_negotiation_instruction` → `pair_offer` → `pair_answer`

**Goal**: when two peers reach `media-ready`, the server issues a per-pair `pair_negotiation_instruction` with `role` + `pairId` + `pairEpoch=1`; both endpoints negotiate via `pair_offer` / `pair_answer`. The offerer creates the DataChannel **before** the offer (FR-050). Stale `pairEpoch` messages are rejected. ICE comes in M7.

- [X] T045 [server] [M6] Pair eligibility evaluator + instruction emission — `signaling/internal/mesh/pairing.go`
    - Purpose: when a participant transitions to `media-ready`, for each existing `media-ready+` peer create a `Pair` (state `Pairing`) at `pairEpoch=1` and emit `pair_negotiation_instruction` to both endpoints. Existing `connected` / `connecting` pairs MUST NOT receive any new instruction (FR-022a).
    - Files: `signaling/internal/mesh/pairing.go` (new).
    - Dependencies: T026, T027, T040.
    - DoD: 4-browser run where the 4th becomes media-ready emits exactly 3 `pair_negotiation_instruction` pairs (6 unicast envelopes — one per side); **no instructions for existing pairs**.
    - Verify: `mesh_pair_instruction_test.go` (T053).

- [X] T046 [frontend][webrtc] [M6] `PairContext` + `PairManager` — `frontend/src/features/mesh/webrtc/{pairContext,pairManager}.ts`
    - Purpose: data-model §B.3; `Map<pairId, PairContext>`; on `pair_negotiation_instruction`, allocate a fresh `RTCPeerConnection`, attach the same local audio + video senders (count invariant `2 × (N − 1)`).
    - Files: 2 new files.
    - Dependencies: T039, T031, T032.
    - DoD: per-pair allocation is idempotent (a duplicate instruction for the same pair + same epoch is no-op + log entry); senders are the SAME local `MediaStreamTrack`s reused across pairs.
    - Verify: `pair.spec.ts` (T053).

- [X] T047 [frontend][webrtc] [M6] DataChannel ownership rule — `frontend/src/features/mesh/webrtc/dataChannel.ts`
    - Purpose: FR-050 — offerer calls `pc.createDataChannel("mesh-chat", { ordered: true })` BEFORE `createOffer`; answerer registers `pc.ondatachannel`.
    - Files: new file.
    - Dependencies: T046.
    - DoD: offerer-side DC exists at the moment of `createOffer`; SDP offer has a data m-line; answerer-side DC arrives via `ondatachannel`.
    - Verify: a unit test using a JSDOM-shimmed PC asserts the order; manual SDP inspection in `chrome://webrtc-internals` shows data m-line in the offer.

- [X] T048 [frontend][webrtc] [M6] Offer/Answer handlers — `frontend/src/features/mesh/webrtc/pairManager.ts`
    - Purpose: offerer: `createOffer` → `setLocalDescription` → emit `pair_offer { pairId, pairEpoch, sdp }`. Answerer: on `pair_offer`, `setRemoteDescription` → `createAnswer` → `setLocalDescription` → emit `pair_answer`.
    - Files: extend pairManager.
    - Dependencies: T046, T047.
    - DoD: both endpoints reach `signalingState === "stable"` after answer is applied.
    - Verify: in a 2-window run, both browsers' Inspector shows `signalingState=stable`; event log records `offer created`, `offer received`, `answer created`, `answer received` with `pairId`.

- [X] T049 [server] [M6] Pair offer/answer relay + epoch validation — `signaling/internal/mesh/handler.go`, `signaling/internal/mesh/pair.go`
    - Purpose: validate `pairId` + `pairEpoch` on inbound `pair_offer` / `pair_answer`; relay envelope-and-payload to the matched `to`; reject stale epochs with `error stale_pair_epoch` (do NOT forward stale).
    - Files: extend handler + pair.
    - Dependencies: T016, T026.
    - DoD: server forwards exactly one offer + one answer per `(pairId, pairEpoch)`; a stale-epoch offer is dropped and the sender receives `error stale_pair_epoch`.
    - Verify: `mesh_pair_epoch_test.go` (T053).

- [X] T050 [frontend][webrtc] [M6] Client-side stale-epoch guard — `frontend/src/features/mesh/webrtc/pairManager.ts`
    - Purpose: every inbound pair message validates `payload.pairEpoch === PairContext.pairEpoch` for the pair; smaller ⇒ drop + emit `pair_stale_message_dropped` event-log entry.
    - Files: extend pairManager.
    - Dependencies: T046.
    - DoD: a synthetic stale `pair_offer` (e.g., from an old failed attempt) does not call `setRemoteDescription`; event log shows the drop.
    - Verify: `pairEpoch.spec.ts` (T053).

- [X] T051 [frontend][P] [M6] Existing-pair stability guard (L18 invariant) — `frontend/src/features/mesh/webrtc/pairManager.ts`
    - Purpose: FR-022a — when a newcomer's `pair_negotiation_instruction` arrives, the existing `PairContext` entries (those without the newcomer) MUST NOT have any state change emitted by the manager.
    - Files: extend pairManager (defensive guard + test scaffold).
    - Dependencies: T046, T048.
    - DoD: `pairManager.handleNewcomerInstructions(...)` only allocates new `PairContext` entries; existing entries' `pc`, `dc`, and `states` references are byte-identical before and after.
    - Verify: `existingPairStability.spec.ts` snapshots pre/post state.

- [X] T052 [P] [server][test] [M6] Server unit tests — `signaling/tests/mesh/mesh_pair_instruction_test.go`, `mesh_pair_epoch_test.go`
    - Purpose: assert pair instructions are emitted only for new pairs and stale-epoch messages are rejected.
    - Files: 2 new test files.
    - Dependencies: T045, T049.
    - DoD: `mesh_pair_instruction_test.go` covers a 4-participant scenario where the 4th joins last and only 3 instruction pairs are emitted; `mesh_pair_epoch_test.go` covers a stale offer.
    - Verify: `go test ./tests/mesh/`.

- [X] T053 [P] [frontend][test] [M6] Frontend unit tests — `frontend/src/features/mesh/tests/{pair,pairEpoch,existingPairStability}.spec.ts`
    - Purpose: cover T046–T051.
    - Files: 3 spec files.
    - Dependencies: T046–T051.
    - DoD: every spec green; the `existingPairStability` spec is the testable surface of L18.
    - Verify: `npx vitest run features/mesh/tests/`.

---

## Phase M7 — Pairwise ICE + remote tiles + per-pair indicators

**Goal**: ICE candidates are exchanged per pair (with end-of-candidates `null`); per-pair candidates are buffered until SRD completes; remote video / audio render per peer; **all four lifecycle states** (`connectionState`, `iceConnectionState`, `iceGatheringState`, `signalingState`) plus `dataChannel.readyState` are visible per remote peer (FR-023, FR-064; Constitution Principle V mandate).

- [ ] T054 [frontend][webrtc] [M7] Per-pair ICE buffer — `frontend/src/features/mesh/webrtc/iceBuffer.ts`
    - Purpose: each `PairContext` gets its own `iceBuffer`; inbound candidates queue if `pc.remoteDescription === null`, else apply via `addIceCandidate`.
    - Files: new file; extension hook in `pairManager.ts`.
    - Dependencies: T046.
    - DoD: out-of-order ICE arrival (candidates before SDP) is correctly buffered + flushed; end-of-candidates (`candidate: null`) is forwarded as-is.
    - Verify: `iceBuffer.spec.ts`.

- [ ] T055 [server] [M7] Pair ICE relay + epoch check — `signaling/internal/mesh/handler.go`
    - Purpose: relay `pair_ice_candidate` envelope-and-payload after `pairId` + `pairEpoch` validation; do not parse the `candidate` string.
    - Files: extend handler.
    - Dependencies: T016, T049.
    - DoD: the test asserts the server forwards the body byte-for-byte (no parsing); rejects `candidate: ""` as `malformed`.
    - Verify: `mesh_ice_relay_test.go`.

- [ ] T056 [frontend][webrtc] [M7] Wire `onicecandidate` + send loop — `frontend/src/features/mesh/webrtc/pairManager.ts`
    - Purpose: emit one `pair_ice_candidate` per local candidate (incl. final `null`).
    - Files: extend pairManager.
    - Dependencies: T046, T054.
    - DoD: ICE trickle reaches the answerer; both endpoints' `iceConnectionState` reaches `connected` (or `completed`) within SC-003's bound on localhost.
    - Verify: `chrome://webrtc-internals` shows candidate exchanges; quickstart §4.2 SC-001 + SC-003 met.

- [ ] T057 [frontend][P] [M7] `RemoteTile` component with five state pills — `frontend/src/features/mesh/components/RemoteTile.tsx`
    - Purpose: display per-peer `connectionState`, `iceConnectionState`, `iceGatheringState`, `signalingState`, `dataChannel.readyState` (5 pills updating live).
    - Files: new component.
    - Dependencies: T046, T036.
    - DoD: 4-browser run shows all five pills updating per remote peer; **L13 demonstrable** (two pairs in different states observed simultaneously).
    - Verify: quickstart §4.2 manual; SC-010 walkthrough confirms L13.

- [ ] T058 [frontend][P] [M7] Remote media rendering on `ontrack` — `frontend/src/features/mesh/components/RemoteTile.tsx`
    - Purpose: attach incoming `MediaStream` to the tile's `<video>` / `<audio>`; event-log entry `remote track received` with `pairId`.
    - Files: extend `RemoteTile.tsx`.
    - Dependencies: T056, T057.
    - DoD: in a 4-browser run, every remote tile shows live audio + video.
    - Verify: quickstart §4.2 SC-001.

- [ ] T059 [frontend][P] [M7] Mesh cost summary panel — `frontend/src/features/mesh/components/MeshCostSummary.tsx`, `frontend/src/features/mesh/state/cost.ts`
    - Purpose: live cost summary per FR-070, FR-071, NFR-007; renders the L14 surface.
    - Files: 2 new files.
    - Dependencies: T034, T046.
    - DoD: at `N ∈ {1, 2, 3, 4}` the panel reads `(0/0/0/0/0/0)`, `(1/1/1/2/0/1/0/0/0)`, `(2/2/2/4/0/2/0/0/0)`, `(3/3/3/6/0/3/0/0/0)` (PCs / DCs / audio / video / total / connected / connecting / failed); room-wide pair total grows as `N × (N−1) / 2`.
    - Verify: `costSummary.spec.ts` (T097).

- [ ] T060 [frontend][P] [M7] Per-pair event log entries for lifecycle transitions — `frontend/src/features/mesh/webrtc/pairManager.ts`
    - Purpose: emit `connection state changed`, `ICE state changed`, `ICE gathering state changed`, `signaling state changed`, `DataChannel opened` event-log entries — each with `pairId`.
    - Files: extend pairManager + eventLog selectors.
    - Dependencies: T046, T035.
    - DoD: per-pair entries are visible and filterable in the event-log panel; FR-061 invariant holds.
    - Verify: `eventLog.spec.ts` (T097); manual filter `pair:<pairId>` in the UI.

- [ ] T061 [test] [M7] M7 acceptance — manual quickstart §4.2 — `quickstart.md §4.2`
    - Purpose: 4-browser mesh; SC-001 + SC-003 met; **L13** demonstrable.
    - Files: none (execution-only checklist).
    - Dependencies: T054–T060.
    - DoD: every step in `quickstart.md §4.2` boxes ticked.
    - Verify: 4-window manual session captured; cost summary at `N=4` matches `(3/3/3/3/6/3/0/0/0)` and room-wide pair total = 6.

---

## Phase M8 — DataChannel mesh chat fan-out (L17)

**Goal**: group chat works over per-pair `RTCDataChannel`s; sender local-echoes **once**; event log records `N − 1` per-channel send entries; receivers each render once. **No DM UI. No global ordering claim. No signaling-relayed final transport.**

- [ ] T062 [frontend][webrtc] [M8] DataChannel `onmessage` + reducer plumbing — `frontend/src/features/mesh/webrtc/dataChannel.ts`, `frontend/src/features/mesh/state/chat.ts`
    - Purpose: register `onmessage` per pair; deserialize; append to `ChatState.messages` exactly once per inbound message (recipient view).
    - Files: extend `dataChannel.ts`; new `chat.ts` reducer.
    - Dependencies: T047 (offerer-creates DC), T060.
    - DoD: a sender posting one message produces exactly one `chat message received` entry on each receiver's chat list.
    - Verify: `chatFanOut.spec.ts`.

- [ ] T063 [frontend][P] [M8] Sender fan-out + local echo — `frontend/src/features/mesh/state/chat.ts`, `frontend/src/features/mesh/components/MeshChat.tsx`
    - Purpose: FR-051 + FR-052 + FR-052a — local echo renders the sent message **once**; iterate `PairMap` and `dc.send(serialize(text))` for each open DC; record `attempted` / `succeeded` / `skipped`; emit one `chat message sent` per pair (succeeded) and one `chat message send skipped` per skipped pair.
    - Files: extend reducer; new `MeshChat.tsx` component.
    - Dependencies: T062.
    - DoD: at `N=4`, sending "hi" appends one entry to sender's chat list, three `chat message sent` entries (one per pair), zero skipped; the MeshChat fan-out summary reads `3 / 3 delivered`.
    - Verify: `chatFanOut.spec.ts` covers the FR-052a invariant (chat UI N=1, event log N−1 entries).

- [ ] T064 [frontend][P] [M8] Chat input validation — `frontend/src/features/mesh/components/MeshChat.tsx`
    - Purpose: FR-054 — trim, reject empty, ≤ 500 chars, render as text only (NFR-006).
    - Files: extend `MeshChat.tsx`.
    - Dependencies: T063.
    - DoD: empty / 501-char / HTML-laden inputs rejected at submit (no fan-out triggered); rendered text shows raw HTML as text, not parsed.
    - Verify: `chatInputValidation.spec.ts`.

- [ ] T065 [frontend][P] [M8] Per-channel ordering only (no global) — `frontend/src/features/mesh/components/MeshChat.tsx`
    - Purpose: FR-055 — display each chat message's local-send timestamp (sender clock) and local-receive timestamp (recipient clock); no cross-peer reordering protocol.
    - Files: extend `MeshChat.tsx`.
    - Dependencies: T063.
    - DoD: the UI does NOT reorder messages from different senders; each entry shows two clocks.
    - Verify: `chatOrdering.spec.ts` confirms no Lamport / vector-clock code path exists; manual run with two simultaneous senders shows possibly-different order on different recipients.

- [ ] T066 [frontend][P] [M8] Skipped-peer log entry on closed DC — `frontend/src/features/mesh/state/chat.ts`
    - Purpose: EC-008 — a peer with `dc.readyState !== "open"` is skipped; one `chat message send skipped` event-log entry per skipped pair, one peer-scoped notice in the UI fan-out summary.
    - Files: extend reducer.
    - Dependencies: T063.
    - DoD: closing one peer's DC then sending a message yields `2 of 3 delivered` summary + one skipped log entry naming the closed peer.
    - Verify: quickstart §4.4 second-to-last step manual.

- [ ] T067 [test] [M8] M8 acceptance — `quickstart.md §4.4` + `chatFanOut.spec.ts`
    - Purpose: SC-006 satisfied; **L17 demonstrable**.
    - Files: none new (test was T063); execution-only checklist.
    - Dependencies: T062–T066.
    - DoD: 4-browser quickstart §4.4 ticked; spec green.
    - Verify: `npx vitest run features/mesh/tests/chatFanOut.spec.ts` PASS + manual.

- [ ] T068 [P][test] [M8] Audit — final-MVP transport is DataChannel only — `frontend/src/features/mesh/tests/chatTransportLabel.spec.ts`
    - Purpose: FR-053 — the chat-event log entries carry `transport: "datachannel"` for final-MVP; if a `signaling` transport branch exists (interim build), the spec asserts the build flag gates it OFF for MVP shipment.
    - Files: new spec.
    - Dependencies: T063.
    - DoD: every chat-event entry's `transport` is `datachannel` in the MVP path.
    - Verify: `npx vitest run features/mesh/tests/chatTransportLabel.spec.ts`.

---

## Phase M9 — Media controls + server-side `pair_media_state` fan-out

**Goal**: mic / cam toggles on one peer update the other `N − 1` peers' tiles via **one** `pair_media_state` signaling message + **server fan-out**.

- [ ] T069 [frontend][webrtc] [M9] Mic / camera toggles — `frontend/src/features/mesh/components/MeshControls.tsx`, `frontend/src/features/mesh/webrtc/senders.ts`
    - Purpose: flip `track.enabled` on the local audio / video tracks; do NOT renegotiate.
    - Files: 2 new / extended files.
    - Dependencies: T039, T046.
    - DoD: mic / camera buttons immediately reflect local state; remote tiles still show the local participant (since SDP + senders are unchanged) but the remote's `RemoteMediaState` indicator updates per T072.
    - Verify: manual; the 001 quickstart pattern §4.2 generalizes.

- [ ] T070 [frontend][P] [M9] Emit one `pair_media_state` per local toggle — `frontend/src/features/mesh/components/MeshControls.tsx`
    - Purpose: FR-032 — exactly one signaling message per state change; client does NOT iterate pairs.
    - Files: extend `MeshControls.tsx`.
    - Dependencies: T069.
    - DoD: mic toggle ⇒ exactly one `pair_media_state` outbound (asserted in test); reflect that the message has no `pairId` (per contract §3.13 note).
    - Verify: `mediaStateOutboundCardinality.spec.ts`.

- [ ] T071 [server] [M9] Server-side fan-out for `pair_media_state` — `signaling/internal/mesh/handler.go`
    - Purpose: receive one `pair_media_state` from a sender; fan out one envelope per **other** participant in the same room with `from = sender.peerId`. Do NOT mutate the payload. Do NOT log mic/cam/screen values.
    - Files: extend handler.
    - Dependencies: T028, T040.
    - DoD: 4-window run with one mic toggle ⇒ exactly 3 outbound envelopes from the server (one per other participant); payload bytes unchanged.
    - Verify: `mesh_media_state_fanout_test.go`.

- [ ] T072 [frontend] [M9] Remote media-state rendering — `frontend/src/features/mesh/components/RemoteTile.tsx`, `frontend/src/features/mesh/state/roster.ts`
    - Purpose: on inbound `pair_media_state`, update `RemoteParticipant.remoteMedia`; render mic / cam / screen icons per FR-033.
    - Files: extend tile + reducer.
    - Dependencies: T034, T071.
    - DoD: remote tiles update within ~1 s of the toggle.
    - Verify: quickstart §4.2 partial; SC for media-state visibility.

- [ ] T073 [P][test] [M9] Server-side fan-out test — `signaling/tests/mesh/mesh_media_state_fanout_test.go`
    - Purpose: assert one client message ⇒ exactly `N − 1` outbound envelopes; assert no payload mutation; assert no media-bytes logging.
    - Files: new test.
    - Dependencies: T071.
    - DoD: scenario covers `N=2`, `N=3`, `N=4`; in each, count outbound envelopes is exactly `N − 1`.
    - Verify: `go test ./tests/mesh/mesh_media_state_fanout_test.go`.

- [ ] T074 [P][test][frontend] [M9] Client outbound cardinality test — `frontend/src/features/mesh/tests/mediaStateOutboundCardinality.spec.ts`
    - Purpose: assert toggling mic / cam emits exactly **one** signaling message (not `N − 1`).
    - Files: new spec.
    - Dependencies: T070.
    - DoD: spec green; explicit anti-test for client-side fan-out.
    - Verify: `npx vitest run features/mesh/tests/mediaStateOutboundCardinality.spec.ts`.

---

## Phase M10 — Concurrent screen sharing (L16)

**Goal**: any participant can start / stop screen share via `replaceTrack`; multiple concurrent sharers; sender count remains `2 × (N − 1)`. **No room-level mutex. No `screen_share_busy`.**

- [ ] T075 [frontend][webrtc] [M10] Screen share start — `frontend/src/features/mesh/webrtc/screenShare.ts`
    - Purpose: `getDisplayMedia({ video: true })`; `replaceTrack(screenTrack)` across every active outbound video sender; emit one `pair_media_state { screenShare: "active" }`; record `local track replaced (camera→screen)` per pair.
    - Files: new file; extension hook in `MeshControls.tsx`.
    - Dependencies: T046, T070.
    - DoD: sharing on one peer replaces the outgoing video track on every connected pair (`N − 1` calls), with one signaling fan-out.
    - Verify: `screenShareSenders.spec.ts`.

- [ ] T076 [frontend][P][webrtc] [M10] Screen share stop (app + browser-native) — `frontend/src/features/mesh/webrtc/screenShare.ts`
    - Purpose: handle in-app Stop button + `screenTrack.onended` (browser-native stop); `replaceTrack(cameraTrack ?? null)`; emit one `pair_media_state { screenShare: "inactive" }`.
    - Files: extend `screenShare.ts`.
    - Dependencies: T075.
    - DoD: both stop paths revert correctly; sender count remains `2 × (N − 1)`.
    - Verify: quickstart §4.5 (stop in-app) + §5.6 (browser-native stop).

- [ ] T077 [frontend][P][webrtc] [M10] Sender-count invariant helper — `frontend/src/features/mesh/webrtc/senders.ts`
    - Purpose: assert `outgoingMediaSenders === 2 × (N − 1)` across screen toggles; the MVP MUST NOT use `addTransceiver` for screen share.
    - Files: extend `senders.ts`.
    - Dependencies: T046, T075.
    - DoD: invariant holds across start / stop cycles; no `addTransceiver` call exists in the screen-share code path.
    - Verify: `screenShareSenders.spec.ts`; grep `addTransceiver` returns no matches under `features/mesh/webrtc/`.

- [ ] T078 [frontend][P][webrtc] [M10] No room-level current-sharer concept — `frontend/src/features/mesh/webrtc/screenShare.ts`
    - Purpose: FR-041 — multiple participants sharing concurrently is first-class; no mutex, no auto-stop, no prompt.
    - Files: defensive structure check (a code-search test) + manual quickstart §4.5 step.
    - Dependencies: T075.
    - DoD: no shared `currentSharer` variable / store / hook exists; manual run with 2 sharers passes (each viewer's tile-of-B and tile-of-C independently render their respective screens).
    - Verify: `concurrentScreenShare.spec.ts` + quickstart §4.5.

- [ ] T079 [test][P] [M10] `screenShareSenders.spec.ts` + `concurrentScreenShare.spec.ts` — `frontend/src/features/mesh/tests/`
    - Purpose: spec coverage for T075–T078 invariants.
    - Files: 2 new spec files.
    - Dependencies: T075–T078.
    - DoD: specs green; explicit tests assert `addTransceiver` is not used in the screen-share path; sender count invariant holds.
    - Verify: `npx vitest run features/mesh/tests/screenShareSenders.spec.ts`.

- [ ] T080 [test] [M10] M10 acceptance — quickstart §4.5 manual; SC-009.
    - Purpose: 2 concurrent sharers + 3rd viewer; **L16 demonstrable**.
    - Files: none new; execution-only.
    - Dependencies: T075–T079.
    - DoD: SC-009 met; quickstart §4.5 ticked.
    - Verify: 3-window run with B + C sharing; A sees both screens.

---

## Phase M11 — Per-PC failure isolation + manual reconnect-this-pair (L15)

**Goal**: a single pair failure surfaces as a `failed` tile + partial-mesh badge **without disturbing other pairs**; per-pair Reconnect rebuilds only that pair under a new `pairEpoch`; ICE restart proper stays out of scope.

- [ ] T081 [frontend][webrtc] [M11] Pair `connectionState === "failed"` handler — `frontend/src/features/mesh/webrtc/pairManager.ts`
    - Purpose: on local detection of failure, update `PairContext.states.connection`, emit `pair_failed` outbound, transition the matching `RemoteParticipant.presence` to `failed`.
    - Files: extend pairManager.
    - Dependencies: T046, T060.
    - DoD: failure on one pair sets only that pair's state; other pair contexts untouched (FR-025).
    - Verify: `failureIsolation.spec.ts`.

- [ ] T082 [frontend][P] [M11] `PartialMeshBadge` — `frontend/src/features/mesh/components/PartialMeshBadge.tsx`
    - Purpose: FR-065 — show a "partial mesh" badge when ≥1 pair is `failed` AND ≥1 pair is `connected`.
    - Files: new component; small extension to `MeshApp.tsx`.
    - Dependencies: T034, T081.
    - DoD: badge renders only in the partial-failure window; no whole-room failure state ever entered (Spec FR-065).
    - Verify: manual; spec covers the truth table.

- [ ] T083 [frontend][P] [M11] Per-pair Reconnect button — `frontend/src/features/mesh/components/RemoteTile.tsx`, `frontend/src/features/mesh/components/ReconnectButton.tsx`
    - Purpose: FR-026 — visible only when this pair's state is `failed`; click sends `reconnect_pair { pairId, observedEpoch }`.
    - Files: extend tile; new button.
    - Dependencies: T081.
    - DoD: button appears only on failed tiles; click triggers the outbound message.
    - Verify: manual; spec.

- [ ] T084 [server] [M11] `reconnect_pair` handler + epoch increment — `signaling/internal/mesh/reconnect.go`
    - Purpose: validate `pairId` + state `failed` + `observedEpoch == currentEpoch`; increment `pairEpoch[pairId]` by `+1`; emit `pair_reconnect_instruction` to both endpoints. Per-`PairId` mutex serializes simultaneous-click races (R-M3).
    - Files: new file; small extension to handler.
    - Dependencies: T026, T049.
    - DoD: simultaneous reconnect clicks produce **one** fresh attempt; the loser receives `error stale_pair_epoch`.
    - Verify: `mesh_reconnect_test.go`.

- [ ] T085 [frontend][webrtc] [M11] Client-side reconnect tear-down + rebuild — `frontend/src/features/mesh/webrtc/pairManager.ts`
    - Purpose: on `pair_reconnect_instruction`, tear down the existing `PairContext` for the pair (close DC, close PC, drop refs, clear `iceBuffer`); construct a fresh `PairContext` under the new `pairEpoch`; run the same flow as M6 (offerer creates DC + offer). **Affects only that pair** (other `PairContext`s untouched).
    - Files: extend pairManager.
    - Dependencies: T046, T084.
    - DoD: clicking Reconnect on one tile resolves to `connected` again under the new epoch; the event log shows `peer pair fresh attempt started` with bumped `pairEpoch`; **no other pair flickers** (asserted by snapshot).
    - Verify: `reconnect.spec.ts`.

- [ ] T086 [P][test][server] [M11] `mesh_reconnect_test.go` + `mesh_pair_epoch_test.go` (extend) — `signaling/tests/mesh/`
    - Purpose: cover happy-path reconnect, simultaneous-click race, and stale-epoch rejection in a 4-participant scenario.
    - Files: extend / new tests.
    - Dependencies: T084.
    - DoD: race produces one fresh attempt; stale-epoch returns `error stale_pair_epoch`; no other pair is touched on the server.
    - Verify: `go test ./tests/mesh/`.

- [ ] T087 [P][test][frontend] [M11] `reconnect.spec.ts` + `failureIsolation.spec.ts` — `frontend/src/features/mesh/tests/`
    - Purpose: cover T081–T085.
    - Files: 2 spec files.
    - Dependencies: T081–T085.
    - DoD: specs green; **L15 demonstrable** in the spec asserts.
    - Verify: `npx vitest run features/mesh/tests/`.

- [ ] T088 [test] [M11] M11 acceptance — quickstart §4.6 manual; SC-007.
    - Purpose: induce a pair failure; observe per-pair `failed` + partial-mesh badge; click Reconnect; observe fresh PC + `pairEpoch` bump in the event log; observe other pairs unaffected.
    - Files: none new; execution-only.
    - Dependencies: T081–T087.
    - DoD: every step in `quickstart.md §4.6` ticked.
    - Verify: 3-window manual run.

---

## Phase M12 — Cleanup, ungraceful disconnect, quickstart, 001 regression

**Goal**: every EC has its expected observable; cleanup ordering matches data-model §C.3; `quickstart.md` is finalized; **the 001 regression checklist is fully green**.

- [ ] T089 [frontend][P] [M12] Local Leave path (Path A) — `frontend/src/features/mesh/webrtc/pairManager.ts`, `frontend/src/features/mesh/components/MeshControls.tsx`
    - Purpose: data-model §C.3 Path A — on user Leave, mark `LocalParticipant.fsm = "leaving"`, close all DCs + PCs, stop local tracks, send `leave_room`, close WS, reset state.
    - Files: extend pairManager + controls.
    - Dependencies: T046, T085.
    - DoD: clean Leave returns the user to the lobby with no event-log error; remaining peers see the leaver as `left` within 10 s (SC-005a).
    - Verify: quickstart §4.7 / §4.9 manual.

- [ ] T090 [P][frontend] [M12] Remote `peer_left` + roster `left` cleanup (Path B) — `frontend/src/features/mesh/webrtc/pairManager.ts`
    - Purpose: data-model §C.3 Path B — close the PC + DC for the leaver; remove their tile + roster entry; **keep local tracks running**; do NOT enter terminal `failed`.
    - Files: extend pairManager.
    - Dependencies: T046, T034.
    - DoD: closing one tab does not turn the local user's camera light off; only the leaver's tile is removed.
    - Verify: quickstart §4.7 manual.

- [ ] T091 [frontend][P] [M12] Local signaling-error UX (Path D) — `frontend/src/features/mesh/components/SignalingErrorBanner.tsx`
    - Purpose: EC-012 / SC-005b — within 5 s of local socket loss, show a banner; transition `LocalParticipant.fsm = signaling-error`; do NOT auto-reconnect; offer Leave-mesh.
    - Files: new component + `local.ts` extension.
    - Dependencies: T031, T033.
    - DoD: blocking `/ws/mesh` in DevTools surfaces the banner < 5 s; existing pairs MAY keep flowing media until natural failure.
    - Verify: quickstart §4.8 manual.

- [ ] T092 [P][server] [M12] Pong-timeout cleanup path → `peer_left` + roster `left` — `signaling/internal/mesh/heartbeat.go`, `handler.go`
    - Purpose: SC-005a — on Pong timeout, release the slot, broadcast roster update `presence: "left"`, additionally emit `peer_left { reason: "disconnect" }` for in-call leavers.
    - Files: extend heartbeat + handler.
    - Dependencies: T029, T040, T084.
    - DoD: closing a tab without graceful Leave produces remaining-peers `left` within 10 s.
    - Verify: `mesh_pong_timeout_test.go` + quickstart §4.7 manual.

- [ ] T093 [P][test][server] [M12] `mesh_no_media_relay_test.go` — `signaling/tests/mesh/mesh_no_media_relay_test.go`
    - Purpose: assert that across all relay paths (`pair_offer`, `pair_answer`, `pair_ice_candidate`, `pair_failed`, `pair_media_state`), the server never inspects, mutates, or stores SDP / ICE / media-state body content; specifically, the message bytes forwarded are byte-identical to bytes received apart from the `from` envelope field.
    - Files: new test.
    - Dependencies: T049, T055, T071.
    - DoD: test passes; explicit grep / fixture asserts no media-frame fields exist anywhere on the server's I/O paths.
    - Verify: `go test ./tests/mesh/mesh_no_media_relay_test.go`.

- [ ] T094 [P] [M12] Quickstart finalize — `specs/002-webrtc-mesh-room/quickstart.md`
    - Purpose: confirm the doc matches the as-built behavior (selectors, banner copy, button labels, event-log entry strings).
    - Files: edit `quickstart.md` (text only; no code changes).
    - Dependencies: T089–T093.
    - DoD: a fresh contributor following the doc reproduces every ticked box.
    - Verify: peer review of one fresh run.

- [ ] T095 [test] [M12] 001 regression run — `specs/001-webrtc-1to1-call/quickstart.md §4`, `§5`
    - Purpose: plan §6.5 + the user's "001 preservation guard" — every 001 quickstart row passes unchanged.
    - Files: none new; execution-only.
    - Dependencies: T005–T093 (cumulative).
    - DoD: every `§4.1`..`§4.7` and `§5.1`..`§5.7` box ticked; `go test ./...` clean (incl. 001 packages); Vitest green incl. 001 specs.
    - Verify: full 001 quickstart manual + automated.

- [ ] T096 [test] [M12] M12 acceptance — full mesh quickstart run + SC matrix.
    - Purpose: SC-001..SC-010 (excluding the L4 cumulative SC-002, which is gated by T095) on a 4-window run.
    - Files: none new; execution-only.
    - Dependencies: T089–T095.
    - DoD: every SC met; **L13–L18 walkthrough (SC-010)** reproducible.
    - Verify: 4-window manual session + ticked quickstart boxes.

---

## Phase Audit — Final cross-cutting audits

These tasks run after M12. Each is a verification, not a new feature.
A failed audit blocks shipment.

- [ ] T097 [P][test] [Audit] Audit — no SFU / no media server / no server-side media relay — `signaling/tests/mesh/mesh_no_media_relay_test.go` (T093) + spec/code review
    - Purpose: cross-check Spec Non-Goals against the as-built code; confirm no SFU abstraction, no media-server intent, no media-relay code path exists on the server.
    - Files: spec/code-review checklist; no new code.
    - Dependencies: T093.
    - DoD: `grep -ri 'sfu\|MediaServer\|forward.*media\|relay.*media' signaling/internal/` returns no matches; T093 is green.
    - Verify: grep results + T093 PASS + reviewer sign-off.

- [ ] T098 [P][test] [Audit] Audit — no v1 contract mutation — `specs/001-webrtc-1to1-call/contracts/signaling-protocol.md`, `signaling/internal/{room,signaling}/`, `frontend/src/{webrtc,signaling,state,components}/`
    - Purpose: ensure 001 v1 contract and modules are byte-for-byte unchanged from `main` (or pre-002 baseline).
    - Files: none new; checklist.
    - Dependencies: T005, T008, T028, T040, T071, T084, T092, T095.
    - DoD: `git diff main -- specs/001-* signaling/internal/{room,signaling} frontend/src/webrtc frontend/src/signaling frontend/src/state frontend/src/components` is empty (or limited to the route-shell additive `App.tsx` wrap explicitly justified in plan §6.2 + T005). The 001 quickstart §4 + §5 (T095) green.
    - Verify: `git diff` review + T095 result.

- [ ] T099 [P][test] [Audit] Audit — no room-level screen-share mutex / no `screen_share_busy` — `frontend/src/features/mesh/`, `signaling/internal/mesh/`
    - Purpose: enforce FR-041 + Non-Goals + plan §10.7.
    - Files: code-review checklist + grep.
    - Dependencies: T075, T078, T079.
    - DoD: `grep -r 'screen_share_busy\|currentSharer\|SharerLock\|sharer.*mutex' frontend/src/features/mesh signaling/internal/mesh` returns no matches; T079 specs green.
    - Verify: grep + spec PASS.

- [ ] T100 [P][test] [Audit] Audit — no signaling-relayed final chat / no global chat ordering claim — T068 + T065
    - Purpose: enforce FR-053 + FR-055 invariants at the contract + UI level.
    - Files: none new.
    - Dependencies: T065, T068.
    - DoD: T068 PASS (no chat type in v2); T065 PASS (no Lamport / vector-clock code path).
    - Verify: spec results.

- [ ] T101 [P][test] [Audit] Audit — `N=4` consistently enforced — `signaling/tests/mesh/mesh_admission_test.go` (T030) + grep
    - Purpose: spec FR-011 — capacity constants in code match the spec value `4` everywhere.
    - Files: code grep + checklist.
    - Dependencies: T024, T030.
    - DoD: `grep -rE 'MaxParticipants|capacity\s*[:=]\s*4|MeshRoomCapacity' signaling/internal/mesh frontend/src/features/mesh` returns matching `4`-valued sites; no rogue `5` or `8`.
    - Verify: grep + T030 PASS.

- [ ] T102 [P][test] [Audit] Audit — every L13–L18 outcome mapped to observable — plan §16.4 walkthrough
    - Purpose: SC-010 — a reviewer can point to one observable surface per L13–L18 in the running app.
    - Files: none new; manual walkthrough.
    - Dependencies: T061, T067, T080, T088, T096.
    - DoD: each of L13/L14/L15/L16/L17/L18 has a checked moment in the walkthrough log (UI screenshot or quickstart bullet referenced).
    - Verify: walkthrough log captured; SC-010 met.

- [ ] T103 [P][test] [Audit] Audit — every pairwise message carries `pairId` + `pairEpoch` — `frontend/src/features/mesh/tests/contract.spec.ts` (T021) + T020
    - Purpose: contract-level invariant; covered by existing tests but listed here as the audit anchor.
    - Files: none new.
    - Dependencies: T020, T021.
    - DoD: T020 + T021 green; reviewer-grep over `frontend/src/features/mesh/signaling/schema.ts` confirms every pair schema requires both fields.
    - Verify: spec results + reviewer grep.

- [ ] T104 [P][test] [Audit] Audit — existing pairs unaffected by newcomer — T053 (`existingPairStability.spec.ts`) + manual
    - Purpose: FR-022a / L18 testable surface.
    - Files: none new.
    - Dependencies: T051, T053.
    - DoD: spec PASS; manual quickstart §4.2 confirms existing tiles never flicker out of `connected` when the 4th joins.
    - Verify: spec + manual screenshot of existing-tile `connectionState` pills during newcomer join.

---

## Output additions (per request)

### Recommended first implementation batch

1. T001 — Add `react-router-dom` (no parallel; everything else waits on this).
2. T002, T003, T004 — Skeleton dirs + compose comment (parallel after T001 starts).
3. T005 — Wrap `App.tsx` in `<BrowserRouter>` (gates M1).
4. T011, T012 — Begin v2 contract Go envelope + Zod envelope (parallel; the rest of M2 fans out from these).

### Tasks that must complete before `/speckit.implement`

**No implementation task must be complete** before invoking
`/speckit.implement` — the command consumes this `tasks.md` directly.
The implement workflow MUST:

- start at T001 (the first task);
- treat the §0.1 phase DAG as binding (no skipping ahead);
- limit the **first execution batch to Setup + M1 + M2 + M3 only**, and
  pause for verification at the end of M3 before proceeding to M4+.

Re-invoke `/speckit.implement` (or continue the same session) after each
phase boundary checkpoint so the M3 → M4 / M7 → M8 / M10 → M11 / M11 → M12
gates are honored.

### Tasks that must complete before any RTCPeerConnection code

T001–T044 (Setup + M1 + M2 + M3 + M4 + M5). Specifically: T029
(server roster + admission), T030 (admission tests), T038 (frontend
shell tests), T044 (two-phase join end-to-end).

### Tasks that must complete before DataChannel chat (M8)

T001–T061 (everything through M7 acceptance). Specifically T046–T053
(pair manager + contract guards) and T054–T061 (per-pair PC + ICE +
indicators) MUST be green so chat has a working pair-state surface to
attach to.

### Tasks that must complete before `reconnect_pair` work (M11)

T026 (server `Pair` + `pairEpoch` ledger), T049 (server pair-relay
epoch validation), T050 (client stale-epoch guard), T053
(`pairEpoch.spec.ts`). Without these, FR-026 is not protected from
R-M2 (stale-message poisoning).

### Tasks that must complete before M12 final verification

T001–T088 (all of M1–M11). T095 (001 regression) is the sole hard
blocker for shipping; it can run in parallel with T094 (quickstart
finalize) but both must pass before M12 acceptance (T096).

---

## Summary

- **Total tasks**: 104 (T001–T104).
- **Parallelizable tasks (`[P]`)**: 47 — concentrated in M2 (Zod / Go validators), M3 (server tests), M4 (reducers), M7 (UI components), M11 (reducers + tests), Audit (final cross-checks).
- **Tag distribution**:
    - `[contract]`: 12 — M2 contract authoring.
    - `[server]`: 28 — M1 (handler), M3 (manager + room), M5 (media flow), M6 (pair eligibility + relay), M7 (ICE relay), M9 (fan-out), M11 (reconnect), M12 (heartbeat + cleanup).
    - `[frontend]`: 47 — M1 (route shell), M4 (reducers + UI), M5 (media UI + retry), M6 (pair manager + DC ownership), M7 (tile + cost), M8 (chat), M9 (controls), M10 (screen share), M11 (failure UI + reconnect button), M12 (cleanup paths + banners).
    - `[webrtc]`: 19 — anything touching `RTCPeerConnection` / `RTCDataChannel` / `MediaStreamTrack`.
    - `[test]`: 27.
    - `[shared-infra]`: 6 — Setup tasks + the route shell + compose comment.
    - `[STOP-001-RISK]`: **0** — no task in the plan requires editing 001 modules in a behavior-changing way. If a `[STOP-001-RISK]` ever appears, plan §6 has been violated; stop and re-design.
- **MVP scope**: Setup + M1–M7 + a slim M12 (regression-only) is the smallest demo that proves SC-001 + SC-002 + SC-003 + L13. M8 (L17) and M10 (L16) are the minimum for the "compare 1:1 vs mesh in chat + screen share" lesson; M11 (L15) closes the failure-isolation lesson. Full SC-010 needs all phases.
- **Independent test criteria per phase**: every M-phase has either a manual quickstart §4.x section or a Vitest / `go test` suite (or both) listed as its DoD.

This list is the complete, sequenced, executable build plan for
`002-webrtc-mesh-room`. Run `/speckit.implement` to begin executing
T001 onward.
