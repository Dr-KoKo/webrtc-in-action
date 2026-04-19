# Specification Quality Checklist: 1:1 WebRTC Learning Call

**Purpose**: Validate the *requirements writing quality* of the spec before
planning — i.e., unit-test the spec's completeness, clarity, consistency,
measurability, and coverage for this WebRTC learning feature.
**Created**: 2026-04-19
**Feature**: [spec.md](../spec.md)

> This checklist tests the **requirements themselves**, not the implementation.
> Each item asks whether something is adequately *written* in the spec, not
> whether a system does something at runtime.

## Requirement Completeness

- [ ] CHK001 — Are the feature's purpose and required learning outcomes
      documented so a planner can verify that later phases preserve them?
      [Completeness, Spec §Purpose & Learning Intent]
- [ ] CHK002 — Are all nine MVP capability areas (room entry, peer presence,
      local media, 1:1 WebRTC call, media controls, text chat, screen sharing,
      connection/event visibility, leaving/cleanup) represented as functional
      requirements with stable IDs? [Completeness]
- [ ] CHK003 — Are cleanup behaviors (stop local tracks, close peer
      connection, release chat transport, notify remote, UI reset) each
      specified as distinct requirements? [Completeness, Spec §FR-023..FR-027]
- [ ] CHK004 — Are requirements defined for every constitution-mandated
      failure case (permission denial, no input devices, ICE failure,
      ungraceful disconnect, WS disconnect, browser-native screen-share stop,
      refresh, leave-during-negotiation)? [Completeness, Spec §Edge Cases]
- [ ] CHK005 — Is the two-phase join model fully specified — admission,
      pending-media, `media_ready`, pairing, and role assignment
      transitions? [Completeness, Spec §FR-010c]
- [ ] CHK006 — Are cleanup requirements defined for pending-media participant
      disconnects that occur **without** an explicit media-failure signal?
      [Completeness, Spec §FR-010d]
- [ ] CHK007 — Are Non-Goals listed explicitly so out-of-scope capabilities
      cannot leak into MVP requirements? [Completeness, Spec §Non-Goals]

## Requirement Clarity

- [ ] CHK008 — Is the "1:1 only" room constraint unambiguous — does the spec
      explicitly reject a third joiner regardless of call-readiness state?
      [Clarity, Spec §FR-002, US1 AC-3, US1 AC-7]
- [ ] CHK009 — Is there a single canonical statement of the offerer-selection
      rule, and is it deterministic (decidable from server state alone)?
      [Clarity, Spec §FR-010a]
- [ ] CHK010 — Is room capacity (slot occupancy) clearly distinguished from
      call-readiness so the terms cannot be confused under two-phase join?
      [Clarity, Spec §Key Entities]
- [ ] CHK011 — Is the screen-share track model unambiguous — exactly one
      outgoing video track per peer, "replacement" not "add"?
      [Clarity, Spec §FR-017, §Assumptions]
- [ ] CHK012 — Is "media flows peer-to-peer" phrased in a way that admits
      TURN relay (for the learning outcome) without contradicting "never
      through the signaling server"? [Clarity, Spec §FR-011]
- [ ] CHK013 — Are event-log semantics clear — each client's log is its own
      perspective, and the two clients' logs are not expected to be
      identical? [Clarity, Spec §US5 Independent Test]
- [ ] CHK014 — Are vague adjectives absent from user-facing requirements
      (e.g., no unquantified "fast", "robust", "intuitive")? [Ambiguity]

## Acceptance Criteria Quality

- [ ] CHK015 — Does each user story (US1–US5) carry acceptance scenarios
      that cover the FRs it claims to cover? [Acceptance Criteria]
- [ ] CHK016 — Are all success criteria (SC-001..SC-009) expressed with
      metrics or observable signals that can be objectively verified without
      referring to implementation details? [Measurability]
- [ ] CHK017 — Is the chat-ordering guarantee stated in testable terms
      (per-sender ordering; no global total order across simultaneous sends)?
      [Measurability, Spec §US3]
- [ ] CHK018 — Does SC-002's time window have an unambiguous start point
      that excludes human reaction time on the permission prompt?
      [Measurability, Spec §SC-002]
- [ ] CHK019 — Are screen-sharing behaviors (start, app-stop, browser-native
      stop, picker-cancel, revert-to-camera, single-slot rule) each covered
      by a testable acceptance scenario? [Acceptance Criteria, Spec §US4]

## Scenario Coverage

- [ ] CHK020 — Is third-peer rejection documented for **both** an already-
      connected room AND a room where both slots are reserved but one is
      still pending-media? [Coverage, Spec §US1 AC-3, AC-7]
- [ ] CHK021 — Does the spec distinguish remote-peer-departure (→ waiting)
      from local connection failure (→ terminal `failed`) with separate
      requirements? [Coverage / Consistency, Spec §FR-005, §Edge Cases]
- [ ] CHK022 — Is offer collision (glare) covered — with its impossibility
      under the deterministic offerer rule explicitly documented? [Coverage,
      Spec §Edge Cases]
- [ ] CHK023 — Is each of the twelve WebRTC learning outcomes traceable to
      at least one visible user-observable behavior in the spec?
      [Coverage, Spec §SC-008]
- [ ] CHK024 — Does the spec document observable behavior for both signaling-
      relayed chat and DataChannel chat transports, so the learning goal is
      preserved regardless of the plan's transport choice? [Coverage, Spec
      §FR-016, §FR-016a, §US5 Conditional events]

## Failure-State Visibility

- [ ] CHK025 — Does every failure mode in Edge Cases carry a requirement
      that makes the failure user-visible (UI message AND event-log entry)?
      [Completeness, Spec §FR-022, §FR-020]
- [ ] CHK026 — Is the permission-denied flow required to surface feedback
      to the user **before** any signaling negotiation begins?
      [Clarity, Spec §FR-010b, §US1 AC-6]
- [ ] CHK027 — Are persistent state indicators (room, peer presence, local/
      remote media, `connectionState`, `iceConnectionState`, `signalingState`,
      screen-share, chat-channel) required as a visible UI surface distinct
      from the event log? [Completeness, Spec §FR-022a, §FR-022b]

## Consistency / No Hidden Production Claims

- [ ] CHK028 — Does the spec avoid implying security or reliability
      properties the MVP does not implement (e.g., E2EE beyond browser
      defaults)? [Consistency / Honesty, Spec §NFR-005]
- [ ] CHK029 — Are "no auto-reconnect" and "advanced reconnect = non-goal"
      statements consistent across Non-Goals, FR-005, Edge Cases, and
      Assumptions? [Consistency, Spec §Non-Goals, §FR-005, §Edge Cases]
- [ ] CHK030 — Is the "signaling server MUST NOT relay media" rule stated
      identically in FR-011, FR-029, and the Separation-of-Concerns
      constitution check, with no contradictory language elsewhere?
      [Consistency, Spec §FR-011, §FR-029]
- [ ] CHK031 — Is the "learning project, not production" framing preserved
      across Purpose, Additional Constraints, Non-Goals, and NFRs — so no
      implied production SLA or 24/7 commitment leaks into MVP
      requirements? [Consistency, Spec §Purpose, §Additional Constraints,
      §Non-Goals]

## Learning Intent Preservation

- [ ] CHK032 — Is chat-transport choice deferred to planning **while** the
      DataChannel-preferred final-MVP intent is locked, so the learning goal
      is not erased by a convenient-but-shallow implementation?
      [Consistency, Spec §FR-016a]
- [ ] CHK033 — Are SDP, ICE, STUN, and TURN learning concepts required to
      surface via a human-readable learning-inspector (not only raw SDP /
      candidate strings)? [Completeness, Spec §FR-030]
- [ ] CHK034 — Does the spec require each chat message to be tagged with
      the path it used (signaling vs DataChannel), so the learner can
      directly observe the distinction? [Completeness, Spec §FR-016, §US5
      Conditional events]

## Scope Boundaries

- [ ] CHK035 — Is every deferred capability (accounts/auth, DB, multi-party,
      SFU/MCU, recording, mobile native, file transfer, monitoring, advanced
      reconnect, custom E2EE, audio-only fallback, invite links, i18n,
      admin tools, non-Docker deployment automation, simultaneous two-track
      camera + screen) listed explicitly in Non-Goals? [Completeness, Spec
      §Non-Goals]
- [ ] CHK036 — Is the 1:1 MVP boundary preserved in every capacity-adjacent
      requirement (no "could support more peers later" implication leaks
      into the MVP codepath requirements)? [Consistency, Spec §FR-002, §IX
      constitution principle, §Non-Goals]

## Traceability

- [ ] CHK037 — Do functional requirements, non-functional requirements, and
      success criteria each carry stable, unique IDs usable by downstream
      tasks? [Traceability, Spec §FRs §NFRs §SCs]
- [ ] CHK038 — Do edge cases carry stable IDs so tasks can reference them
      individually? [Traceability, Spec §Edge Cases]
- [ ] CHK039 — Does each acceptance scenario map clearly (implicitly or
      explicitly) to at least one FR it exercises? [Traceability]
- [ ] CHK040 — Are the twelve learning outcomes individually traceable to
      the specific FRs, SCs, or ACs that make them observable?
      [Traceability, Spec §Purpose, §SC-008]

## Notes

- A `[ ]` means the check is **not yet evaluated** in this file; see the
  **Evaluation** section below for the actual pass/fail judgment against
  the current `spec.md`.
- Items tagged `[Gap]` mean the spec is missing a requirement; `[Ambiguity]`
  means a requirement exists but is unclear; `[Conflict]` means two
  requirements disagree.

---

## Evaluation against current `spec.md` (2026-04-19)

Format: **CHK### — Status** — notes.

### Requirement Completeness

- **CHK001 — PASS.** `## Purpose & Learning Intent` names the 12 learning
  outcomes as an enumerated list; SC-008 binds the spec to them.
- **CHK002 — PASS.** Every capability maps to FRs: room entry (FR-001..005),
  peer presence (FR-005, FR-022a/b), local media (FR-006..009, FR-010b),
  1:1 call (FR-010..012, FR-010a..d), media controls (FR-013, FR-014, FR-014a),
  chat (FR-015, FR-015a, FR-016, FR-016a), screen sharing (FR-017..019),
  connection visibility (FR-020..022b, FR-030), leaving/cleanup (FR-023..027).
- **CHK003 — PASS.** FR-023 (leave), FR-024 (stop tracks), FR-025 (close PC +
  release chat), FR-026 (notify remote), FR-027 (UI reset).
- **CHK004 — PASS.** Edge Cases section enumerates all 9 constitution
  failures + offer-collision; each has a behavior requirement.
- **CHK005 — PASS.** FR-010c walks through six phases including slot
  reservation, `media_ready`, and `paired` transition.
- **CHK006 — PASS.** FR-010d's "Pending-media disconnect (no signal
  available)" block covers the WS-close / tab-close path.
- **CHK007 — PASS.** Non-Goals section is explicit, marked constitution-G-5
  mandatory.

### Requirement Clarity

- **CHK008 — PASS.** FR-002 caps at 2 participants; US1 AC-3 rejects Carol in
  a connected room; US1 AC-7 rejects Carol even when one slot is still
  pending-media. Key Entities says capacity is slot-based, not readiness-based.
- **CHK009 — PASS.** FR-010a is the canonical rule: first admitted ⇒ offerer.
  Assumption § and Clarifications § both reference FR-010a as canonical
  rather than restating a second rule.
- **CHK010 — PASS.** Key Entities splits **slot occupancy** (`0/1/2 reserved`)
  from **call-readiness** (`empty / waiting_for_media / waiting_for_peer /
  paired`).
- **CHK011 — PASS.** FR-017: "exactly **one outgoing video track per peer** …
  replaces … MUST NOT send camera and screen as two separate remote video
  tracks." Assumption repeats this with "LOCKED". Non-Goals pins it again.
- **CHK012 — PASS.** FR-011: "either **directly between peers** when NAT
  traversal permits, or **through a TURN relay** when required … Media MUST
  NEVER flow through the application signaling server."
- **CHK013 — PASS.** US5 Independent Test: "each side's event log shows the
  ordered lifecycle events relevant to that side … The two sides' logs are
  **not expected to be identical**."
- **CHK014 — PASS.** Spot-check: no unquantified "fast", "robust",
  "intuitive", "modern" in FR bodies. SCs carry numeric bounds (2 s, 5 s,
  10 s, 500 chars, 64 chars).

### Acceptance Criteria Quality

- **CHK015 — PASS with note.** Every user-facing FR is exercised by at least
  one AC across US1–US5. Non-user-facing architectural requirements
  (FR-028 signaling-contract meta, FR-029 signaling-only relay) are
  intentionally not exercised by user ACs — they are plan/review gates.
  Acceptable.
- **CHK016 — PASS.** SC-001 (first-try connection), SC-002 (5 s from
  `paired`), SC-003 (2 s rejection), SC-004 (visible lifecycle in UI),
  SC-005 (5 s cleanup + no device-in-use), SC-006 (2 s permission clarity),
  SC-007 (2 s screen-share stop), SC-008 (12 learning outcomes mapped),
  SC-009 (10 s ungraceful detection).
- **CHK017 — PASS.** US3 Independent Test and AC-2 explicitly exclude a
  global total order and lock per-sender ordering.
- **CHK018 — PASS.** SC-002 anchors the window at "the room reaching
  `paired` call-readiness", which by definition excludes permission-prompt
  time.
- **CHK019 — PASS.** US4 AC-1 (start + single-slot replacement), AC-2
  (app-stop revert), AC-3 (browser-native stop revert), AC-4 (picker
  cancel). FR-017/018/019 and SC-007 reinforce each.

### Scenario Coverage

- **CHK020 — PASS.** US1 AC-3 for the connected case, US1 AC-7 for the
  pending-media case. Key Entities also codifies it.
- **CHK021 — PASS.** FR-005 now explicitly splits the two flows, and the
  ICE-failure edge case ends in terminal `failed` with manual Leave/Rejoin.
- **CHK022 — PASS.** Edge Cases: "Offer collision (glare) → MUST NOT occur
  under the deterministic offerer rule … if ever observed, logged as
  `error occurred`."
- **CHK023 — PASS.** Spot-check of the 12 outcomes against observable
  surfaces: why-signaling (US5 logs), offer/answer (US5 + FR-010a),
  SDP/ICE/STUN/TURN (FR-030 inspector), signaling-vs-media (FR-011/029),
  local→remote tracks (US5 `remote track received`), muting-vs-stopping-vs-
  replacing (US2 + FR-013/014/014a + FR-017), screen-share affects tracks
  (US4 AC-1), DataChannel (FR-016a + US5 conditional chat events),
  disconnect (Edge Cases + SC-009). SC-008 binds all 12.
- **CHK024 — PASS.** FR-016 requires path observability; US5 Conditional
  lifecycle events REQUIRE each chat log entry to tag the path used.

### Failure-State Visibility

- **CHK025 — PASS.** FR-022 requires an `error occurred` entry for every
  user-surfaced error; FR-020 mandates timestamped readable log.
- **CHK026 — PASS.** FR-010b: "Any permission error MUST be surfaced … before
  signaling negotiation begins"; US1 AC-6 verifies this end-to-end.
- **CHK027 — PASS.** FR-022a enumerates all 9 persistent indicator classes;
  FR-022b adds pending-media visibility with bidirectional updates.

### Consistency / No Hidden Production Claims

- **CHK028 — PASS.** NFR-005: "application MUST NOT claim or imply end-to-end
  security properties beyond … DTLS/SRTP"; additional Constraints also calls
  the scope "learning project, not operational scale".
- **CHK029 — PASS.** "No advanced reconnect" in Non-Goals; FR-005 says local
  connection failures go to terminal `failed` with manual rejoin; Edge Cases
  repeats the ban.
- **CHK030 — PASS.** FR-011 + FR-029 + Principle III in constitution are
  aligned. No contradictory language found.
- **CHK031 — PASS.** Purpose says "not … production video conferencing
  platform", Additional Constraints says "toy in scope but not a toy in
  discipline", Non-Goals excludes production monitoring / deployment
  automation.

### Learning Intent Preservation

- **CHK032 — PASS.** FR-016a locks DataChannel as final-MVP target; FR-016
  keeps the path observable; signaling-relayed chat is explicitly permitted
  "only as an interim milestone".
- **CHK033 — PASS.** FR-030 requires the learning inspector to summarize
  SDP type, m-sections, candidate types, STUN config + srflx observation,
  and TURN configured/unavailable.
- **CHK034 — PASS.** US5 Conditional lifecycle events: `chat message sent`
  / `chat message received` MUST tag signaling-path vs DataChannel-path.

### Scope Boundaries

- **CHK035 — PASS.** Non-Goals enumerates every listed item, including the
  newest additions (deployment-automation beyond Docker, simultaneous
  two-track camera+screen).
- **CHK036 — PASS.** FR-002 caps at 2; constitution Principle IX caps at 1:1
  MVP; Non-Goals repeats "No multi-party calls (>2 peers)". No "could scale
  later" language leaks into the requirement text.

### Traceability

- **CHK037 — PASS.** FR-001..FR-030 + lettered variants, NFR-001..NFR-006,
  SC-001..SC-009.
- **CHK038 — PASS (fixed 2026-04-19).** Edge-case bullets now carry
  stable IDs `EC-001`..`EC-013` (in document order). Downstream tasks
  can reference individual edge cases by ID.
- **CHK039 — PASS with note.** Each AC is scoped within a user story whose
  scope overlaps specific FR groups; the mapping is implicit but unambiguous
  in every case inspected (e.g., US2 AC-1..4 ↔ FR-013/014/014a).
  **Recommendation:** consider adding `Covers: FR-xxx` tags for mechanical
  traceability — not blocking.
- **CHK040 — PASS with note.** SC-008 asserts full learning-outcome coverage
  and Purpose lists the 12 outcomes. A per-outcome mapping table would be
  ideal but is not required; the current spec lets a reviewer walk the
  session and check each outcome.

---

## Result

**Pass / Fail summary** (after fix for CHK038)

- PASS: 40 / 40
- FAIL: 0 / 40
- PASS-with-note (non-blocking recommendations): 3 (CHK015, CHK039, CHK040)

**Blocking issues before `/speckit.plan`**: none.

---

## Post-plan cross-document re-evaluation (review-pass-4, 2026-04-19)

A review of the Phase-0/Phase-1 artifacts against the spec surfaced a
different class of issue — **inconsistencies between spec, data-model,
and signaling contract** that would have destabilized implementation.
These are not "requirements quality" failures (the spec itself was
internally consistent); they are **cross-document alignment failures**.
They have been fixed. For traceability:

- Spec `§US5 AC-1`: "every entry from both groups" → now explicitly
  limits the happy-path log expectation to Base events + Conditional
  events whose trigger occurred. Failure-only conditionals are checked
  via their dedicated edge cases.
- Spec / data-model / contract: pre-admission rejection unified under
  a single `join_rejected` message; post-admission release unified
  under a single `participant_released` message.
- Spec `FR-022b` / data-model / contract: `peer_presence_changed`
  replaces the separate `peer_joined` / `peer_left` /
  `peer_state_changed` designs.
- Data-model: `Participant.state` split into orthogonal `MediaReadiness`
  and `CallPhase` enums; room call-readiness = `paired` now holds
  across the in-call progression.
- Data-model `§C.5`: three distinct cleanup paths (local leave /
  remote peer_left / local terminal failure) — `peer_left` MUST NOT
  stop local tracks.
- Data-model `§B.1`: added `media_error` as a retry-able state;
  terminal `failed` is reserved for local peer-connection failure.
- Data-model `§B.1.1`: `SignalingTransportState` added as an
  orthogonal state machine so a WS drop during `connected` doesn't
  promote the session to terminal `failed`.
- Research / contract: heartbeat re-anchored to 5s ping + 5s timeout
  (≤10s worst-case) to satisfy SC-009.
- Contract: `media_ready` now requires `audio && video`; end-of-
  candidates is `candidate: null` only; envelope `from` is omitted on
  server-originated system messages.
- Plan: DoD bullets no longer carry `[x]` (agents read that as
  "already completed").

**Checklist re-evaluation verdict**: all 40 items still PASS. The
changes strengthened consistency without invalidating any previously-
passing item. Ready for `/speckit.tasks`.

---

## Post-review-pass-5 delta (2026-04-19, second cross-document sweep)

A re-review of the plan and protocol against the spec caught **stale
terminology in `plan.md`** (Phase 3/4 contract-message lists + Diagram
2 peer_joined), **`in-call` checks in the signaling contract that no
longer matched the split server state**, and **an obsolete legacy
row** in the error table. Fixed:

- `plan.md` Phase 3 contract list: `room_full` / `peer_joined`
  replaced by `join_rejected` / `peer_presence_changed`; notes added
  explaining that `join_rejected_room_full` is a payload result, not
  a message type.
- `plan.md` Phase 4 contract list: `participant_released_media_failed`
  clarified as a payload result of the `participant_released` message.
- `plan.md` Diagram 2 (join + negotiation): all `peer_joined`
  transitions replaced with explicit `peer_presence_changed` pairs
  (pending-media admitted, then ready after `media_ready`).
- `plan.md` Diagram 3 (screen share): `media_state` now flows A → S → B
  explicitly (not A → B), preserving the signaling-vs-media-path
  distinction. Explanatory note added.
- `plan.md` source-tree comments aligned with canonical decisions:
  `state.go` is `MediaReadiness + CallPhase`, `heartbeat.go` is
  `5s ping, 5s pong`, `slog_setup.go` is `JSON default`.
- `data-model.md §B.1` "Transitions on failure" rewritten: media
  failure → `media_error` (retry-able, not terminal); WS drop during
  `connected` → `SignalingTransportState = error` with `SessionState`
  preserved.
- `contracts/signaling-protocol.md` offer / answer / ice_candidate /
  media_state validation blocks rewritten to use the split server
  model (`mediaReadiness == ready` + `callPhase ∈ {...}` + role
  check), removing all `state MUST be in-call` language.
- `contracts/signaling-protocol.md §3.12 peer_left` scoped to
  **in-call** departures only. Pending-media releases are delivered
  exclusively via `peer_presence_changed`. `peer_left` payload
  reasons reduced to `graceful_leave` / `disconnect`.
- `contracts/signaling-protocol.md §3.13 participant_released` now
  explicitly notes that the message cannot reach a disconnected peer;
  the remaining reserved peer learns via
  `peer_presence_changed(presence="released", reason="disconnect")`.
- `contracts/signaling-protocol.md §3.15 error` table: `room_full`
  row removed (it was a legacy double-channel). Added explicit banner
  stating that `room_full` and `invalid_room_id` are NOT error codes
  — they ride on `join_rejected`.
- `contracts/signaling-protocol.md` error table now includes
  `unsupported_media_capability` (matches the `media_ready` audio+video
  requirement locked in review-pass-4).
- `data-model.md §C.5 Path C` Rejoin clarified: Rejoin = Leave + fresh
  Join (Option A). No new `release_slot` / `restart_join` message is
  added to the MVP contract.
- `spec.md` Clarifications review-pass-2 SC-002 entry updated from
  "second participant reports `media_ready`" to "room reaches
  `paired` call-readiness" to match canonical SC-002 wording.

**Verdict**: all 40 checklist items still PASS. Plan + contract +
data-model are now internally consistent end-to-end — there are no
more stale message-type names, no more single-flat-state server
checks, and no more ambiguous recovery paths. **Ready for
`/speckit.tasks`** without risk of resurrecting superseded protocol
names.

## Proposed concrete spec changes

### (Required) Fix for CHK038 — Add IDs to Edge Cases

Rename the 13 Edge Case bullets to prefix each with a stable `EC-###` ID so
tasks, tests, and review comments can reference them unambiguously. Proposed
numbering (in document order):

- `EC-001` User joins an empty room
- `EC-002` User joins a room with one peer waiting
- `EC-003` Third user attempts to join an occupied 1:1 room
- `EC-004` User denies camera or microphone permission
- `EC-005` User has no camera or microphone hardware
- `EC-006` WebRTC connection fails due to network restrictions
- `EC-007` ICE gathering completes without a viable connection
- `EC-008` Remote peer refreshes the page
- `EC-009` Remote peer closes the browser without a graceful leave
- `EC-010` WebSocket signaling disconnects during negotiation
- `EC-011` User stops screen sharing via the browser's native control
- `EC-012` User leaves during offer/answer negotiation
- `EC-013` Offer collision (glare)

### (Non-blocking) Recommendation for CHK039

Optional: annotate each acceptance scenario block with a trailing
`_Covers: FR-xxx, FR-yyy_` line. Improves mechanical traceability for task
generation; not required.

### (Non-blocking) Recommendation for CHK040

Optional: add a small **Learning-Outcome Traceability** subsection under
Purpose that tabulates each of the 12 outcomes against the FRs/SCs/ACs that
make it observable. Not required — SC-008 already binds the spec to the
12 outcomes as a whole.
