# Phase 0 — Research & Decisions

**Feature**: 1:1 WebRTC Learning Call
**Branch**: `001-webrtc-1to1-call`
**Date**: 2026-04-19

This document resolves every technology and design question the implementation
plan depends on. Because the user supplied most of the stack up-front in
`/speckit.plan`, most entries below justify the given choices rather than
search for unknown ones. Pedagogical fit (Constitution Principle I + Additional
Constraints) is the dominant selection criterion throughout.

Each entry follows:
**Decision** / **Rationale** / **Alternatives considered** / **Impact on spec**.

---

## 1. Frontend stack — React + TypeScript + Vite, direct WebRTC APIs

**Decision**: React 18+, TypeScript strict mode, Vite for dev/build. Use
`RTCPeerConnection`, `RTCDataChannel`, `navigator.mediaDevices.getUserMedia`,
`navigator.mediaDevices.getDisplayMedia`, and `RTCRtpSender.replaceTrack`
directly. **No** WebRTC wrapper libraries (no simple-peer, no PeerJS).

**Rationale**:

- The project exists to teach WebRTC primitives (Purpose & Constitution I).
  A wrapper hides the exact concepts the learner must observe.
- Vite is the smallest-moving-parts bundler for a React+TS toy project;
  HMR keeps the inner loop tight for state-machine debugging.
- TypeScript strict mode encodes the signaling contract and client state
  machine as types, which catches entire classes of protocol drift at
  compile time (supports Principle II, Contract-First Signaling).

**Alternatives considered**:

- **simple-peer / PeerJS**: rejected — abstracts exactly the state
  transitions we must expose.
- **Next.js / Remix**: rejected — SSR and routing are out of scope for a
  single-page two-pane UI; adds complexity without learning value.
- **Plain JS without TS**: rejected — we lose compile-time validation of
  the signaling contract.

**Impact on spec**: Supports FR-030 (learning inspector), FR-022a/b (state
indicators), Principle I (primitives exposed).

---

## 2. Signaling server stack — Go with a small WebSocket library

**Decision**: Go 1.22+. Use **`github.com/coder/websocket`** (also known
historically as `nhooyr.io/websocket`) for the WebSocket handshake +
frames. Use `net/http` for routing (`/healthz`, `/ws`) without a router
framework. Keep the server under ~500 LoC for the MVP.

**Rationale**:

- Go's goroutines give a natural model: one goroutine per WS connection,
  per-room mutex for state transitions. Simple, idiomatic, no callback
  hell.
- `coder/websocket` is **context-aware**, has a modern API, zero external
  dependencies, and explicit close-code handling. This matters for the
  two-phase-join cleanup path (pending-media disconnect in FR-010d).
- `gorilla/websocket` is the alternative. It's the historical default
  and works fine, but its API predates `context.Context` and is older.

**Alternatives considered**:

- **`gorilla/websocket`**: acceptable fallback; rejected as first choice
  only because of the older ergonomics. If `coder/websocket` hits any
  incompatibility, swap is mechanical.
- **Node.js / Express + ws**: rejected — the user asked for Go.
- **A routing framework (chi, gin, echo)**: rejected — two routes do not
  justify a router (Principle IX: simplicity first).

**Impact on spec**: Supports FR-028 (documented contract), FR-029 (pure
signaling, no media), and NFR-004 (simplicity).

---

## 3. Chat transport — RTCDataChannel (final) vs WebSocket-relayed (optional interim)

**Decision**: The **final MVP** MUST use **RTCDataChannel** for chat
(spec FR-016a). The plan schedules a **signaling-WebSocket interim
milestone** in Phase 9a *only if* DataChannel integration risk is high;
otherwise skip straight to DataChannel. Regardless of transport, each
message carries its path in its log entry (spec FR-016 + US5 conditional
event `chat message sent/received` with transport tag).

**Comparison**:

| Aspect | RTCDataChannel | Signaling-relayed (WS) |
|---|---|---|
| Teaches peer-to-peer data | **Yes** (the whole point) | No |
| Server sees message content | No | Yes |
| Works before `RTCPeerConnection` is connected | No | Yes |
| Ordering guarantee | Ordered by default | Ordered (one WS) |
| Implementation effort | Moderate (negotiation + `onopen` + state) | Trivial |
| MVP goal fit | **Required** | Debug shortcut only |

**Rationale**:

- DataChannel is a required learning outcome ("what DataChannel is and
  when it is useful"). Replacing it with signaling-relayed chat silently
  deletes the lesson.
- Allowing an interim WS-relay gives the plan an incremental path
  (Principle IV). But the interim version MUST NOT be the final ship.

**Trade-offs acknowledged**:

- DataChannel chat cannot send before the peer connection is established;
  the UI must disable the input or queue locally until `datachannel.open`.
- DataChannels require offer/answer negotiation that includes a data
  m-line. The offerer creates the DataChannel *before* creating the
  offer so the SDP includes data.

**Alternatives considered**: See table above.

**Impact on spec**: FR-016, FR-016a, FR-015a, US3, US5 conditional chat
events, FR-022a (chat-channel state indicator).

---

## 4. Screen-share track strategy — `RTCRtpSender.replaceTrack`

**Decision**: Implement screen sharing by calling **`replaceTrack`** on
the existing outgoing video `RTCRtpSender`, substituting the camera
track with the `getDisplayMedia` video track. On stop, `replaceTrack`
again with the camera track (if camera is on) or null/black frame (if
camera is off). This matches spec FR-017 ("exactly one outgoing video
track per peer; replaces, does not add").

**Rationale**:

- `replaceTrack` does not require renegotiation → no offer/answer round
  trip for a common user action → lower latency and fewer moving parts.
- Aligns with the single-outgoing-video-slot rule locked in FR-017 and
  the Non-Goals entry excluding simultaneous camera+screen remote tracks.
- Teaches track replacement, a stated learning outcome.

**Alternatives considered**:

- **Renegotiation (remove track + addTrack screen + offer/answer)**:
  rejected as default. Teaches a different concept (renegotiation) but
  at the cost of ~1s extra latency on every start/stop. May be
  exercised as an optional secondary demo in a later extension
  milestone; the event log already includes `signaling state changed`
  entries that would surface the renegotiation if that path is later
  enabled.
- **Add a second `RTCRtpSender` for screen**: rejected — contradicts
  FR-017 / Non-Goals.

**Impact on spec**: FR-017, FR-018, FR-019, US4 AC-1..4.

---

## 5. Offerer-role protocol — first-admitted + `ready_for_offer`

**Decision**: The server is the sole authority on which participant is
the offerer. On transition to `paired` call-readiness (both peers
`media_ready`), the server sends each client a `ready_for_offer`
message carrying `role: "offerer" | "answerer"`. Clients MUST NOT
initiate `createOffer` until they receive `role: "offerer"`. This
eliminates glare by construction (spec FR-010a + EC-013).

**Rationale**:

- Admission order is deterministic on the server (monotonically
  assigned on `join_accepted`). First-admitted = offerer is stable
  under two-phase join even when the second-admitted peer reaches
  `media_ready` first.
- A single out-of-band `ready_for_offer` message is cheaper than any
  SDP-based glare resolution.

**Alternatives considered**:

- **"Polite peer" pattern** (perfect negotiation): rejected — too much
  machinery for a 1:1 learning toy. Documented as an extension idea.
- **Client-side lexicographic peer ID comparison**: rejected — moves
  authority off the server and complicates the mental model.

**Impact on spec**: FR-010a, EC-013, signaling contract
(`ready_for_offer` message).

---

## 6. ICE candidate buffering

**Decision**: Each client maintains a `pendingRemoteCandidates: RTCIceCandidateInit[]`
buffer. Behavior:

- If a remote `ice_candidate` arrives **before** the remote description
  is set, push it into the buffer. Do NOT call `addIceCandidate`.
- When `setRemoteDescription` resolves, drain the buffer into
  `addIceCandidate` in order.
- Local candidates (from `onicecandidate`) are sent to the server
  immediately as they are gathered; no local buffering.

**Rationale**: Remote candidates arriving before the remote SDP is set
will fail `addIceCandidate` with `InvalidStateError`. Buffering is the
standard pattern and, in a 1:1 toy, fits in ~10 lines.

**Alternatives considered**:

- **Send remote `setLocalDescription` first then candidates**: the
  offerer controls its own order, but the answerer cannot prevent the
  remote offerer's candidates arriving before the answerer has
  processed the offer. Buffering is still required.
- **Use only non-trickle ICE**: rejected — fails on restricted networks
  and hides the `ICE candidate sent / received` lifecycle the learner
  must see.

**Impact on spec**: US5 Base event `ICE candidate sent / received`,
FR-030 learning inspector, EC-006/EC-007.

---

## 7. STUN / TURN strategy

**Decision**:

- **STUN**: default to Google's public STUN
  (`stun:stun.l.google.com:19302`) in dev. Configurable via environment
  (`VITE_STUN_URLS`).
- **TURN**: **not** provisioned by default. Docker Compose includes a
  **commented-out `coturn` service** with a sample `turnserver.conf`
  so a learner can enable it in a later milestone when they want to
  exercise the TURN learning outcome.
- Credentials always sourced from env (`VITE_TURN_URL`,
  `VITE_TURN_USERNAME`, `VITE_TURN_CREDENTIAL`). Never committed.

**Rationale**:

- Public STUN is fine for local-dev learning per spec Additional
  Constraints. Production deployment is out of scope (Non-Goals).
- Coturn is the standard open-source TURN; bundling the config (but
  not the service) satisfies "document TURN as a fallback" without
  adding a permanently-running service the MVP doesn't need.

**Alternatives considered**:

- **Always-on coturn in Compose**: rejected — runtime cost + exposed
  credentials in example configs. Commented-out is safer.
- **Third-party managed TURN (e.g., Twilio, Xirsys)**: rejected —
  requires an account and network access for a local toy.

**Impact on spec**: FR-030 (STUN configured + srflx observed, TURN
configured), NFR-001/002 (secure context, no hardcoded secrets).

---

## 8. Signaling message envelope format

**Decision**: JSON over text WebSocket frames. Canonical envelope:

```json
{
  "v": 1,
  "type": "offer",
  "roomId": "demo",
  "from": "peer-a",
  "to": "peer-b",
  "requestId": "uuid-...",
  "ts": 1713500000000,
  "payload": { "...": "..." }
}
```

- `v` — integer contract version (starts at 1).
- `type` — enum, lowercase snake_case (`join_room`, `offer`, ...).
- `roomId` — present on every room-scoped message.
- `from` / `to` — peer IDs; `to` is optional for server broadcasts to
  the sender.
- `requestId` — client-generated UUIDv4 for correlating responses /
  errors; optional but recommended for request-style messages.
- `ts` — Unix ms timestamp, informational.
- `payload` — type-specific fields (schema per message).

**Rationale**: A single, predictable envelope makes validation,
logging, and testing uniform. Version field supports Principle II
(contract versioning).

**Alternatives considered**:

- **Protobuf / MessagePack**: rejected for MVP — binary formats make
  the event log harder to read (violates observability goal).
- **Per-message unique top-level fields**: rejected — harder to write a
  single generic dispatcher / validator.

**Impact on spec**: FR-028 (documented contract), FR-030 (inspector
reads structured data).

---

## 9. Validation library choice (Go + Frontend)

**Decision**:

- **Go**: pure-standard-library validation. Each message type has a
  handwritten `validate() error` method. No schema library.
- **Frontend**: **Zod** for runtime validation of outgoing and incoming
  messages.

**Rationale**:

- The message set is small (≈14 types) and the contract is internal —
  JSON Schema + Go code generation would be more infrastructure than
  the toy justifies (Principle IX).
- Zod on the frontend pays for itself because it also infers
  TypeScript types from schemas, so the signaling contract has one
  source of truth on the client.

**Alternatives considered**:

- **JSON Schema + ajv + quicktype**: rejected — 3 tools, 2 generated
  artifacts to keep in sync.
- **Protobuf / buf**: rejected — overkill for 14 message types.
- **Just TypeScript types + trust the server**: rejected — we want the
  client to reject malformed messages at the boundary (NFR-006-adjacent
  safety).

**Impact on spec**: FR-028 conformance, FR-022 (`error occurred` log
entries for validation failures).

---

## 10. Testing stack

**Decision**:

- **Backend (Go)**: standard `testing` package + `stretchr/testify` for
  assertions. WebSocket integration tests use `httptest.NewServer` +
  `coder/websocket`'s client.
- **Frontend (TS)**: **Vitest** + **React Testing Library** for unit
  tests of reducers, hooks, and component state transitions. JSDOM for
  DOM APIs.
- **Protocol-flow tests**: backend-level Go tests that drive the WS
  endpoint through the full `join → media_ready → ready_for_offer →
  offer → answer → ice → leave` sequence using scripted WS clients.
  These are the "tests the protocol, not the pixels" tests required by
  Constitution Principle VIII.
- **Manual cross-browser tests**: a checklist in `quickstart.md` for
  Chromium, Firefox, Safari.

**Rationale**:

- Vitest is Vite-native (no separate config), significantly faster
  than Jest, and identical API for the 80% case.
- Go standard `testing` + testify is idiomatic and keeps the Go module
  graph short.

**Alternatives considered**:

- **Playwright for end-to-end browser tests**: deferred to a later
  feature. The MVP's protocol-flow tests already exercise the
  signaling contract; adding Playwright is a separate scope item.
- **Jest**: rejected — no reason to adopt it alongside Vite.

**Impact on spec**: Constitution Principle VIII (testing discipline).

---

## 11. Docker Compose shape

**Decision**: One `docker-compose.yml` at repo root with three services:

- `frontend`: Node + Vite dev server on `:5173`.
- `signaling`: Go signaling server on `:8080`.
- `coturn`: **commented out** by default; when enabled, binds UDP
  `:3478`. Sample `turnserver.conf` lives at `infra/coturn/`.

Frontend talks to signaling at `ws://localhost:8080/ws` during local
dev (browser secure-context exception for localhost). Production notes
state HTTPS/WSS is required outside `localhost`.

**Rationale**: Matches the user's explicit infra decision; minimizes
what's always running; makes TURN a deliberate opt-in (useful for the
"when TURN becomes necessary" learning outcome).

**Alternatives considered**:

- **Kubernetes / Helm**: rejected — out of scope (Non-Goals).
- **Separate Compose files per service**: rejected — one file is
  simpler for a 2-to-3-service system.

**Impact on spec**: NFR-001 (secure context note), Non-Goals
(deployment automation).

---

## 12. Logging / observability on the server

**Decision**: Go standard `log/slog` with a **JSON handler as the
default in all environments** (dev and prod-ish). A text handler
remains selectable via env `LOG_FORMAT=text` for humans reading logs
without tooling, but the default is JSON because correlation by
`room_id` / `peer_id` is one of the core learning aids and is much
easier to filter with `jq` (which `quickstart.md §8` uses). Every log
line carries `room_id`, `peer_id`, and `event` fields. Never log SDP
bodies, ICE candidates, or TURN credentials (Spec NFR-003).

**Rationale**: `slog` is stdlib as of Go 1.21+. Structured keys feed
directly into per-room/per-peer correlation — matches Constitution
Principle IV's "correlation IDs per session and per peer" bar without
needing a logger framework. JSON-first means `docker compose logs
signaling | jq 'select(.room_id == "demo")'` works out of the box.

**Alternatives considered**:

- **zap / zerolog**: rejected — `slog` covers 100% of our needs with
  zero external deps.
- **Raw `log.Printf`**: rejected — no structure, hard to filter
  per-room during multi-room debugging (even in 1:1 toy, two
  concurrent rooms exist during protocol-flow tests).

**Impact on spec**: NFR-003 (observability + secret-free logs).

---

## 13. Heartbeat / disconnect detection

**Decision**: Use WebSocket **Ping/Pong** frames. Server sends a Ping
every **5 seconds**; considers the peer dead if no Pong within **5
seconds** of the Ping. Worst-case ungraceful-disconnect detection is
therefore **~10 seconds** (peer goes silent right after a Ping is
sent → wait for next ping interval → wait for pong timeout). A
10s/10s layout gives a 20s worst case and would **miss SC-009** —
that is why 5/5 is the chosen default, not 10/10. Both intervals are
env-configurable (`PING_INTERVAL_MS`, `PONG_TIMEOUT_MS`). Client uses
the browser's automatic Pong response — no app-level heartbeat
protocol.

**Rationale**:

- Leverages the native WS mechanism — no custom app-level ping needed.
- Meets SC-009's 10-second ungraceful-disconnect detection bound
  **with margin** (the server measures against monotonic clock).
- `coder/websocket` supports ping/pong primitives directly.

**Alternatives considered**:

- **App-level ping/pong JSON messages**: rejected — duplicates the
  WS-level mechanism and clutters the event log.
- **Longer heartbeat window (e.g., 30 s)**: rejected — violates SC-009.

**Impact on spec**: SC-009, EC-008, EC-009, EC-010.

---

## 14. Project layout — monorepo with two packages

**Decision**: Single repository, single `docker-compose.yml`, two top-
level packages: `frontend/` (Vite+React+TS) and `signaling/` (Go
module). Shared signaling-contract documentation under
`specs/001-webrtc-1to1-call/contracts/signaling-protocol.md` is the
single source of truth; types on each side reference it.

**Rationale**: Two-package monorepo is the minimum shape that allows
spec-driven contract sharing without premature workspace tooling
(Principle IX).

**Alternatives considered**:

- **Two separate repos**: rejected — the contract is shared; coupling
  the repos makes synchronized changes tedious.
- **pnpm/yarn workspaces with code-generated TS types**: deferred —
  would be appropriate if the message set grew, but overkill for 14
  messages.

**Impact on spec**: Supports the Constitution's "single source of
truth" for the contract (Principle II).

---

## All NEEDS CLARIFICATION resolved

Every question the plan depends on has a locked answer above. The plan
can proceed to Phase 1 (data model + contracts) without further spec
clarifications.
