# Phase 0 Research: Multi-party Mesh WebRTC Learning Room

**Branch**: `002-webrtc-mesh-room` | **Date**: 2026-04-25
**Plan**: [plan.md](./plan.md)
**Spec**: [spec.md](./spec.md)

This document records the Phase 0 research decisions for the mesh
feature. Each topic was triggered by a specific spec requirement, plan
constraint, or risk. The 001 research (`specs/001-webrtc-1to1-call/research.md`)
is the baseline; topics below are mesh-specific deltas or refinements.

---

## 1. Frontend stack — reuse 001 stack, add `react-router-dom`

**Decision**: Keep the 001 frontend stack (React 18 + TypeScript strict + Vite + Zod + Vitest + RTL + direct browser WebRTC APIs, no wrappers). Add a single new dependency: `react-router-dom` for the route shell at `/` (001) and `/mesh/:roomId` (002).

**Rationale**:
- Spec FR-001..FR-003 require both modes runnable in the same build. A real router is the smallest correct boundary that keeps 001 components from leaking mesh awareness (Constitution Principle IX, 001 Preservation Boundary §6).
- The mesh feature does not change how WebRTC primitives are called from JS; the existing direct-API approach is already fine for mesh's per-pair lifecycle.

**Alternatives considered**:
- *Hand-rolled `location.pathname` switch* — rejected because it would force every shared component to know about the current mode (creates accidental 001 behavior changes; risks G-5 violation).
- *Hash routing* — rejected; modern browsers and dev tools (and `BrowserRouter`) already support clean paths on `localhost`.
- *Workspace tooling (pnpm/yarn workspaces, nx, turborepo)* — rejected; one new dependency is cheaper than reorganizing the build (Principle IX).

---

## 2. Signaling stack — same Go + `coder/websocket`, separate `/ws/mesh` endpoint

**Decision**: Keep `github.com/coder/websocket` v1.8.14 + stdlib `net/http` + `log/slog`. Register a **second** WS endpoint `/ws/mesh` next to the existing `/ws`. Mesh handler lives in a new package `signaling/internal/mesh/`. The 001 packages (`signaling/internal/{room,signaling}/`) are not edited beyond what is explicitly necessary for `cmd/signaling/main.go` to register the new endpoint.

**Rationale**:
- The v1 contract semantics MUST remain frozen (Spec FR-002, plan §6). Multiplexing a `mode` discriminant onto `/ws` would either break v1 validators or require editing the v1 contract — both forbidden.
- A separate endpoint cleanly separates the v1 and v2 envelopes (`v: 1` vs `v: 2`); no validator on either side has to know about both contracts.

**Alternatives considered**:
- *Multiplex on `/ws` with a `mode` field on `join_room`* — rejected: would either need to extend v1 (breaks freeze) or require unknown-field tolerance on v1 validators (breaks Principle II).
- *gRPC / streaming RPC for mesh* — rejected: out of scope, learner is supposed to read the JSON; consistent with 001's WS-JSON choice.

---

## 3. Pairing protocol — server-driven `pair_negotiation_instruction`

**Decision**: The mesh server is **authoritative** about which peer-pairs need to be created and what role each side plays. When two participants are both `media-ready` and don't already have an active pair, the server emits a unicast `pair_negotiation_instruction` to each side carrying `pairId`, `pairEpoch`, `role` (`offerer` / `answerer`), `iceServers`, and the remote peer descriptor. The client does not invent pair IDs and does not auto-pair on roster change.

**Rationale**:
- This is the per-pair generalization of 001's `ready_for_offer`. It preserves the same "server tells you when to create the PC" pattern, so 001 and mesh are pedagogically consistent.
- It eliminates client-side glare-avoidance code: with the server emitting exactly one instruction per pair, no client has to second-guess role assignment.
- Spec FR-022 + FR-022a + Assumption "Deterministic offerer per peer-pair" all converge on this model.

**Alternatives considered**:
- *Implicit pairing on roster: clients see `media-ready` and start their own offers* — rejected: makes role assignment depend on roster broadcast ordering and becomes fragile under reconnect.
- *Server gives just role; client decides `pairId`* — rejected: server-canonical `pairId` (from sorted `admission_index` pair) is robust across reconnect.

---

## 4. Pair identity — `pairId` and `pairEpoch`

**Decision**:
- `pairId = "<lo>-<hi>"` where `lo` and `hi` are the two `admission_index`es sorted ascending, formatted as decimal strings (e.g., `"3-7"`). Stable for the lifetime of the pair across reconnects.
- `pairEpoch` is a `uint64` issued and incremented exclusively by the server. First attempt = `1`. Every server-issued `pair_reconnect_instruction` increments by `+1`. Every pairwise message (`pair_offer`, `pair_answer`, `pair_ice_candidate`, `pair_media_state`, `pair_failed`, `pair_negotiation_instruction`, `pair_reconnect_instruction`) carries `pairEpoch` in its payload.
- Stale-message rule: any pairwise message whose `payload.pairEpoch` is less than the pair's currently-known epoch is **dropped**, both server-side (returned as `error stale_pair_epoch`) and client-side (logged peer-scoped, no state change).

**Rationale**:
- Spec FR-021a mandates pair-attempt identity. Without this, a fresh reconnect (FR-026) is poisonable by stale offers/answers/ICE/DataChannel-meta from the failed attempt (R-M2 in plan §19).
- Server-issued epoch (vs. client-issued) ensures both endpoints see a monotonic, agreed-upon ordering even under simultaneous reconnect clicks (R-M3 resolution in plan §14.1).

**Alternatives considered**:
- *Random per-attempt UUID* — works for stale-message rejection but loses the "newer attempt wins" total ordering needed for race resolution.
- *Client-issued counter* — rejected: two clients can mint colliding counters; server arbitration becomes painful.

---

## 5. `admission_index` semantics — monotonic, **never reused** within a mesh room

**Decision**: `admission_index` is a `uint64` issued at admission time per `MeshRoom`. It is **monotonically increasing for the lifetime of the room** and is **never reused** when a slot frees and another participant takes it.

**Rationale**:
- 001 reuses `admissionOrder` (1 or 2) when a slot frees, which is fine for 1:1 because there are only two values and the offerer rule is unambiguous given any pairing (the live pair has both indices).
- Mesh reconnect-this-pair (FR-026) and the stable `pairId = "<lo>-<hi>"` invariant both depend on `admission_index` being stable across the room's lifetime. If two slots are freed and a newcomer takes the lower one, reusing the index would make the new pair collide with the **old** pair's `pairId` (since `pairId` is derived from the indices).
- The cost of one extra `uint64` per room is trivial; the benefit is reconnect correctness.

**Alternatives considered**:
- *Reuse like 001* — rejected: breaks reconnect correctness as described.
- *UUID per participant* — works but breaks the "first admitted is the offerer" pedagogical mapping; FR-022 explicitly carries 001 FR-010a forward into mesh.

---

## 6. `media_state` propagation — server-side fan-out (locked by spec)

**Decision**: Spec FR-032 locks media-state propagation to **server-side fan-out**: a client emits **one** `pair_media_state { from: <self>, mic, camera, screen }` message; the server fans out one envelope per other participant in the same mesh room, setting `from = sender.peerId` on each. The server validates the sender, never parses or mutates the payload, and never relays media bytes (FR-024 / FR-091 still apply).

**Rationale**:
- Preserves 001's signaling-server-as-router model for metadata.
- Reduces client bandwidth from `N − 1` outbound messages per state change to `1`. Important on weak networks (R-M5).
- Keeps the cost summary's L17 message about **DataChannel** fan-out (which IS client-side, per FR-051) cleanly distinct from media-state fan-out (which is server-side).

**Alternatives considered**:
- *Client-side fan-out for media-state* — rejected by spec FR-032.
- *Embed media-state in `peer_presence_changed`* — rejected: media-state changes are runtime events independent of the FR-013 7-state lifecycle and conflating them violates FR-013a state separation.

---

## 7. DataChannel ownership — offerer-creates, answerer-receives, before SDP

**Decision**: The lower-`admission_index` offerer for each pair calls
`pc.createDataChannel("mesh-chat", { ordered: true })` **before**
`createOffer` so the offer's SDP includes a data m-line. The
higher-`admission_index` answerer registers `pc.ondatachannel` and does
NOT call `createDataChannel`. This is the per-pair generalization of
001's "offerer creates the chat DataChannel before the m-line"
convention.

**Rationale**:
- Spec FR-050 mandates this exact rule. Without it, both endpoints might create channels (duplicate channels per pair) or neither might (zero channels per pair).
- Ordered + reliable mode is correct for chat (no need to lose messages, no need for unreliable speed).

**Alternatives considered**:
- *Negotiate `negotiated: true` channel with explicit `id`* — works but requires manual ID coordination per pair; the offerer-creates model leverages the existing role assignment.
- *Single shared "room" DataChannel* — impossible without an SFU (FR-051); mesh has only per-pair channels.

---

## 8. Chat ordering — per-channel only, no global order (FR-055)

**Decision**: Chat messages preserve order **within** each `RTCDataChannel` (a property of the default ordered/reliable mode). No global cross-pair order is provided. The UI displays each chat message's local-send timestamp (sender clock) and local-receive timestamp (recipient clock) so a learner can manually reason about ordering. The MVP introduces no vector clocks, no causal-delivery protocol, and no Lamport timestamps.

**Rationale**:
- Spec FR-055 explicitly accepts this; it is also one of the L17 lessons (per-channel ordering is what RTCDataChannel guarantees in mesh).
- Implementing a global order would re-introduce the SFU pattern (need a serializer); that is out of scope.

**Alternatives considered**:
- *Lamport / vector clock total order* — rejected by spec.
- *Server-assigned monotonic message ID* — rejected: chat in final MVP MUST NOT travel through the server (FR-051, FR-053).

---

## 9. Screen-share strategy — `replaceTrack`, no renegotiation, no `screen_share_busy`

**Decision**: Starting / stopping screen share uses
`RTCRtpSender.replaceTrack` across every active outbound video sender
(`(N − 1)` calls per share start). The MVP does NOT renegotiate, does
NOT `addTransceiver`, and does NOT introduce a `screen_share_busy` (or
equivalent) signaling message. Multiple participants may share
concurrently; no room-level current-sharer concept exists.

**Rationale**:
- Spec FR-040..FR-043 + FR-070 sender-count invariant + Non-Goals all converge.
- `replaceTrack` is exactly the 001 strategy (`research.md §4`); generalizing to N − 1 senders preserves the L16 lesson.
- Browser-native stop is handled via `screenTrack.onended`, identical to 001.

**Alternatives considered**:
- *Renegotiation per share start* — rejected: doubles the SDP traffic and breaks the sender-count invariant.
- *Server-issued "sharer lock"* — rejected by FR-041 + Non-Goals.

---

## 10. Validation library — Zod (frontend), hand-rolled validators (Go)

**Decision**: Same as 001 — Zod schemas in `frontend/src/features/mesh/signaling/schema.ts`; hand-rolled `validate()` per type in `signaling/internal/mesh/protocol.go`. The contract document (`contracts/signaling-protocol.md`) is the single source of truth; both implementations derive from it.

**Rationale**:
- Consistency with 001 validates the contract-first approach (Principle II).
- Zod gives runtime + compile-time types from one source; hand-rolled Go validators avoid pulling in a JSON-schema dep just for this.

**Alternatives considered**:
- *JSON Schema in the contract + codegen on both sides* — overkill for an MVP at this scale; the contract document has 19 types and the schemas are small.

---

## 11. Heartbeat / disconnect detection — same 5 s + 5 s as 001

**Decision**: `/ws/mesh` uses the same WS-level Ping / Pong layout as
`/ws`: 5 s ping interval + 5 s pong timeout. Worst-case detection ≤
10 s, satisfying SC-005a. Configurable via the same `PING_INTERVAL_MS` /
`PONG_TIMEOUT_MS` env vars (shared constant).

**Rationale**:
- Spec SC-005a uses the same 10 s bound as 001 SC-009.
- Sharing the constants avoids drift between endpoints.

**Alternatives considered**:
- *Application-level heartbeat JSON message* — rejected: WS-level Ping/Pong is already supported by browsers and Go libs; adding a JSON heartbeat would inflate the contract.

---

## 12. Local signaling-error UX (EC-012, SC-005b)

**Decision**: When the local `/ws/mesh` socket closes unexpectedly while
the local participant has at least one active `PairContext`, the
frontend transitions `LocalParticipant.fsm = signaling-error` and
displays a **persistent banner** above the mesh roster within `5 s`
(SC-005b). The banner offers a single action: **Leave mesh**, which
performs the standard cleanup. **Already-established peer-pairs MAY
continue carrying media and DataChannel traffic** until they fail on
their own (per Spec EC-012). No automatic signaling reconnect.

**Rationale**:
- Spec SC-005b sets the 5 s bound and EC-012 sets the local-vs-remote split.
- Allowing existing P2P pairs to continue is the honest WebRTC behavior; manually masking them as "failed" would teach the wrong lesson (signaling drop ≠ media drop).

**Alternatives considered**:
- *Auto-reconnect signaling* — rejected by Non-Goals.
- *Tear down all PCs immediately on signaling drop* — rejected: would obscure the WebRTC invariant that media is independent of signaling.

---

## 13. Event-log capacity and filtering

**Decision**: Bounded ring buffer of 1000 entries. UI exposes a filter
strip (`all | room | peer:<id> | pair:<id>`). At `N = 4` with 6 pairs,
typical session generates ~50–200 entries during join/connect; 1000
gives ample headroom for rare-event review without dominating memory or
DOM (R-M7).

**Rationale**:
- 001 uses 500 entries for a single-pair scenario; mesh has 6× the cardinality, so 2× the budget is the conservative middle.
- Filter UI keeps the first-paint experience uncluttered.

**Alternatives considered**:
- *Unbounded* — rejected: long sessions would leak.
- *Per-pair sub-logs only* — rejected: room-scoped events (`room joined`, roster events) need a home.

---

## 14. Test runner & layout — same as 001

**Decision**: Vitest + RTL (frontend), `go test` + testify (backend). Tests
under `frontend/src/features/mesh/tests/` and `signaling/tests/` (the
latter shared with 001 — separate filenames per feature). No new
dependencies.

**Rationale**: Consistent with 001; lowers learning friction.

---

## 15. Browser support

**Decision**: Chromium current + current-1 are the primary target. Firefox
and Safari are best-effort and divergences are documented in
`quickstart.md §7`. The known divergences worth calling out:

- Firefox emits `iceconnectionstatechange` slightly differently around `failed → disconnected → failed` cycles; the per-pair `iceConnectionState` indicator must tolerate both orderings.
- Safari's `getDisplayMedia` prompt UX differs and requires a user-gesture proximate to the call.
- Codec defaults differ across browsers; per Spec Non-Goals, the MVP MUST NOT introduce codec selection. Cross-browser interop relies on whatever the browsers default to.

**Rationale**: Same posture as 001. Mesh does not change browser surface area beyond `replaceTrack` × `(N − 1)` and per-pair PCs, both already supported.

---

## All NEEDS CLARIFICATION resolved

The Phase 0 sweep finds no remaining `[NEEDS CLARIFICATION]` markers and
no spec ambiguities that block planning. The reviewer-supplied
`mesh.md` checklist is at **53 / 53 PASS** (pass 2). Phase 1
(`data-model.md`, `contracts/signaling-protocol.md`, `quickstart.md`)
proceeds.
