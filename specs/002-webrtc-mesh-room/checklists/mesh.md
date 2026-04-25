# Mesh Spec Quality Checklist: Multi-party Mesh WebRTC Learning Room

**Purpose**: Validate requirement quality (completeness, clarity, consistency, measurability, coverage) of `spec.md` before `/speckit.plan`. Items below test the **requirements as written**, not the implementation.
**Created**: 2026-04-25
**Feature**: [spec.md](../spec.md)
**Scope**: Reviewer-supplied checklist categories (Learning intent, 001 coexistence, Mesh scope, Mesh topology, Pairwise negotiation, Chat, Screen sharing, Failure isolation, Observability, Acceptance criteria).
**Evaluation pass 1**: 2026-04-25 — 44 / 53 items PASS, 9 FAIL (1 blocker). See **Evaluation report (pass 1)** at the bottom.
**Evaluation pass 2**: 2026-04-25 — **53 / 53 PASS**. All pass-1 failures resolved by reviewer-pass-2 spec edits (L13–L18 IDs, FR-026 manual reconnect-this-pair via fresh PC, FR-021a pair-attempt identity, FR-022a existing-pair stability, FR-013a state separation, FR-032 server-fan-out direction, FR-052a chat local echo, freeze-flavor split, codec-selection / `screen_share_busy` / WebRTC-no-room-level-screen-share clarifications). Spec is **plan-ready**. See **Evaluation report (pass 2)** at the bottom.

## Learning intent

- [x] CHK001 Is the feature framed as a WebRTC learning project rather than a production conferencing product? [Clarity, Spec §Purpose & Learning Intent]
- [x] CHK002 Is the pedagogical reason for adding mesh **after** 001 1:1 explicitly stated (i.e., why mesh is the next step)? [Completeness, Spec §Primary learning goal]
- [x] CHK003 Is SFU explicitly identified as a future, **separate** feature (not part of 002)? [Completeness, Spec §Constitutional alignment, §Non-Goals]
- [x] CHK004 Are the mesh-specific learning outcomes (the reviewer's "L13–L18") explicitly listed **and assigned stable IDs** that survive into acceptance criteria? [Traceability, Spec §Learning outcomes the feature MUST make explicit]
- [x] CHK005 Does the spec confirm that 001's existing learning outcomes remain reachable through the preserved 001 mode? [Coverage, Spec §FR-002, US2 AS#1, SC-002]

## 001 coexistence

- [x] CHK006 Is "001 1:1 behavior remains available" stated as a hard requirement (not a best-effort goal)? [Clarity, Spec §FR-002]
- [x] CHK007 Is "002 does not replace 001" stated explicitly? [Completeness, Spec §FR-001..FR-003, §Non-Goals]
- [x] CHK008 Is the requirement that learners can directly compare 1:1 and mesh in the **same running build** specified? [Completeness, Spec §FR-003, US2]
- [x] CHK009 Is it specified that 001's existing v1 signaling-contract semantics MUST NOT be modified by 002 (additive only)? [Consistency, Spec §FR-090, §Assumptions → 001 codepath untouched]
- [x] CHK010 Does the spec distinguish **behavioral freeze** of 001 (acceptance criteria preserved) from **implementation-shell freeze** (no code modifications), or are they conflated? [Ambiguity, Spec §Non-Goals "No removal or rewrite of the 001 1:1 codepath", §Assumptions]

## Mesh scope

- [x] CHK011 Is mesh capacity locked to **exactly 4** participants for MVP (not "at least 4" or "configurable")? [Clarity, Spec §FR-011, §Assumptions → Capacity = 4 (LOCKED)]
- [x] CHK012 Is 5th-participant rejection specified with a measurable behavior (latency target + no side-effects)? [Measurability, Spec §FR-011, §EC-002, §SC-004]
- [x] CHK013 Is "no >4-participant behavior is required" stated as a non-goal? [Completeness, Spec §Non-Goals "No support for more than 4 participants in MVP"]
- [x] CHK014 Is "no waiting queue and no auto-promotion when full" specified? [Completeness, Spec §FR-011]
- [x] CHK015 Are SFU, MCU, simulcast/SVC, **codec selection**, recording, E2EE, file transfer, auth, persistent chat, invite links, and production-deployment automation explicitly out-of-scope? [Coverage, Spec §Non-Goals]

## Mesh topology

- [x] CHK016 Is the rule "each participant maintains one RTCPeerConnection per remote peer" stated as a hard requirement? [Completeness, Spec §FR-020]
- [x] CHK017 Is the local PC-count formula `N − 1` explicitly stated and measurable? [Measurability, Spec §FR-070, §SC-008]
- [x] CHK018 Is the N=4 case (3 local PCs per peer, 6 unordered peer-pairs total) specified as a testable acceptance criterion? [Acceptance Criteria, Spec §US1 AS#2, §SC-008]
- [x] CHK019 Is the O(N²) cost made directly observable in the running app (not just stated in prose)? [Measurability, Spec §FR-070, FR-071, NFR-007]

## Pairwise negotiation

- [x] CHK020 Is per-peer-pair offerer selection deterministic? [Clarity, Spec §FR-022]
- [x] CHK021 Is the ordering basis (server-side stable order, specifically `admission_index`) explicitly named and direction-locked? [Clarity, Spec §FR-022, §Assumptions → Deterministic offerer per peer-pair]
- [x] CHK022 Is "a newcomer pairs with every existing media-ready participant" specified? [Completeness, Spec §FR-020, §US1 AS#2/#5, §FR-012a/FR-012b roster delivery]
- [x] CHK023 Is it specified that **existing peer-pairs are NOT paused or renegotiated** when a newcomer joins? [Gap, Spec §FR-020, §US1 AS#2]
- [x] CHK024 Are offer/answer and ICE lifecycle requirements **pair-scoped** (not room-global)? [Consistency, Spec §FR-021, FR-023, FR-025]

## Chat

- [x] CHK025 Is RTCDataChannel fan-out locked as the **final** mesh chat transport (not a best-effort suggestion)? [Clarity, Spec §FR-051, FR-053]
- [x] CHK026 Is signaling-relayed broadcast explicitly disallowed as the final mesh chat transport? [Completeness, Spec §FR-053, FR-091]
- [x] CHK027 Is "one group send produces N − 1 DataChannel writes" stated and measurable? [Measurability, Spec §FR-051, FR-052, §SC-006]
- [x] CHK028 Is **local echo** (sender's own UI rendering the just-sent message) specified as a requirement? [Gap, Spec §US4, §FR-051..FR-053]
- [x] CHK029 Is "global total ordering across all peers is NOT required" stated as a deliberate non-requirement? [Clarity, Spec §FR-055]

## Screen sharing

- [x] CHK030 Is the single-outgoing-video-slot rule per participant specified? [Clarity, Spec §FR-040]
- [x] CHK031 Is multiple-concurrent-screen-sharers permission specified as a hard requirement? [Completeness, Spec §FR-041, US6, EC-011]
- [x] CHK032 Is "no room-level current-sharer mutex" stated as a deliberate non-requirement? [Clarity, Spec §FR-041, §Non-Goals]
- [x] CHK033 Is "**no `screen_share_busy` error**" stated as a deliberate non-requirement (so the contract doesn't accidentally introduce one)? [Gap, Spec §FR-041, §Non-Goals]
- [x] CHK034 Does the spec make the pedagogical point that **WebRTC has no native room-level "screen share" concept** (it is purely a per-peer outgoing-track replacement)? [Ambiguity, Spec §FR-040..FR-043, §Learning outcomes]

## Failure isolation

- [x] CHK035 Is failure scoped per RTCPeerConnection (not per room)? [Clarity, Spec §FR-025]
- [x] CHK036 Is "A↔B failing does not fail A↔C or A↔D" stated as a hard isolation requirement? [Completeness, Spec §FR-025, US7]
- [x] CHK037 Is it specified that the mesh **room** does not enter a terminal failed state because one peer-pair fails? [Consistency, Spec §FR-025, FR-065]
- [x] CHK038 Is a manual **"reconnect-this-pair" affordance** (creating a fresh RTCPeerConnection for the failed pair) specified? [Gap/Conflict, Spec §US7 AS#2 currently offers only "Leave / Remove"; §Assumptions "No reconnection / no ICE restart" actively rules it out]
- [x] CHK039 If reconnect-this-pair is in scope, is **"ICE restart proper" explicitly out of scope** (i.e., reconnect creates a fresh PC, not an ICE restart on the existing PC)? [Ambiguity, depends on CHK038 decision]

## Observability

- [x] CHK040 Is it required that every event-log entry tied to a remote peer carries `peerId` or pair context? [Clarity, Spec §FR-061, §US3 AS#2]
- [x] CHK041 Are per-pair `connectionState`, `iceConnectionState`, `iceGatheringState`, `signalingState`, AND `dataChannelState` ALL specified as visible? [Completeness, Spec §FR-023, FR-064, Key Entities → Peer-Pair]
- [x] CHK042 Is a mesh cost summary required, covering participant count, local PC count, local DataChannel count, outgoing-sender count, AND connected/failed/pending pair count? [Coverage, Spec §FR-070]
- [x] CHK043 Is the outgoing-sender count quantified **exactly** (`2 × (N − 1)`), not "≥ N"? [Measurability, Spec §FR-070, §US8 AS#2, §SC-008]
- [x] CHK044 Is the per-pair failure count visible in the cost summary? [Completeness, Spec §FR-070]
- [x] CHK045 Is the partial-mesh room-level indicator distinct from a whole-room failure indicator? [Clarity, Spec §FR-065]
- [x] CHK046 Does each mesh-specific learning outcome have at least one specified observable moment (UI indicator or event-log entry)? [Coverage, Spec §SC-010]

## Acceptance criteria

- [x] CHK047 Is a **3-peer** join scenario specified as testable? [Acceptance Criteria, Spec §US1 AS#2, §SC-008 step-by-step]
- [x] CHK048 Is a **4-peer** full-room scenario specified as testable? [Acceptance Criteria, Spec §SC-001, §US1 AS#2]
- [x] CHK049 Is **5th-participant rejection** (with measurable latency) specified as testable? [Acceptance Criteria, Spec §SC-004, §EC-002]
- [x] CHK050 Is **DataChannel fan-out** (with exact send count for N=4) specified as testable? [Acceptance Criteria, Spec §SC-006, §US4 AS#1]
- [x] CHK051 Is **concurrent screen-share** (≥2 sharers) specified as testable? [Acceptance Criteria, Spec §SC-009, §US6]
- [x] CHK052 Is **per-pair failure isolation** specified as testable? [Acceptance Criteria, Spec §SC-007, §US7]
- [x] CHK053 Is a **001-regression check** specified (i.e., proving 001 acceptance criteria still hold while mesh runs)? [Acceptance Criteria, Spec §SC-002, §US2 AS#1]

---

## Evaluation report — 2026-04-25 pass 1

> **⚠ SUPERSEDED — historical only.** This pass-1 report is retained as
> a record of the reviewer's first read; **do not treat its FAIL rows as
> open issues**. All 9 failures listed below were resolved by the
> reviewer-pass-2 spec edits; the authoritative current state is
> **53 / 53 PASS** in **Evaluation report — 2026-04-25 pass 2** further
> down. `/speckit.plan` and any downstream agents MUST consult pass 2,
> not this section, for current spec quality.

**Score**: 44 / 53 PASS (83%). 9 FAIL: 1 blocker, 8 non-blocking.

### Failures

| ID | Class | Evidence | Smallest fix | Blocks `/speckit.plan`? |
|----|-------|----------|--------------|--------------------------|
| **CHK004** | Gap (Traceability) | Spec §"Learning outcomes the feature MUST make explicit" lists 9 prose bullets without IDs. SC-010 references "the nine learning outcomes" but no `L13`/`L14`/… IDs exist. The reviewer's checklist refers to L13–L18 by ID, which has no anchor in the spec. | Assign stable IDs (e.g., `L13`–`L21`) to the bullets in §Learning outcomes; reference those IDs in SC-010 and in any acceptance scenarios that turn on a particular learning outcome. | No |
| **CHK010** | Ambiguity | Two flavors of 001 freeze are mixed: FR-002 (behavioral) and Non-Goals "No removal or rewrite of the 001 1:1 codepath" + Assumptions "001 codepath untouched" (implementation-shell). A refactor that preserves all 001 behavior is technically forbidden by the latter. | Add one paragraph to Assumptions distinguishing the two: **behavioral freeze** is mandatory (all 001 FRs/AS/SC/contract semantics preserved); **implementation-shell** changes that preserve behavior (mode router, shared utility extraction, file moves) are permitted and not within the "No removal or rewrite" prohibition. | No |
| **CHK015** | Gap (Coverage) | §Non-Goals enumerates SFU, MCU, simulcast, E2EE, recording, file transfer, auth, persistent chat, invite links, production-deployment automation — but **codec selection** is missing. Codec defaults appear only in §Assumptions ("documented where it diverges"). | Add to §Non-Goals: "**No custom codec selection or codec preferences.** Browser default codec negotiation applies; the MVP MUST NOT introduce a codec-selection UI, signaling fields, or `setCodecPreferences` calls." | No |
| **CHK023** | Gap | §FR-020 mandates that each (local, remote) pair has one PC, and US1 AS#3 says no existing pair is disturbed when a 5th is **rejected**, but no FR/AS explicitly says existing pairs continue uninterrupted when a newcomer is **admitted**. Implementations could in principle pause or renegotiate. | Add to §FR-020 (or as US1 AS#5 amendment): "When a newcomer is admitted, the existing peer-pairs MUST continue carrying media and DataChannel traffic without interruption; no pause, no renegotiation, no track-replacement is performed on existing pairs as a side effect of the new pairing." | No |
| **CHK028** | Gap | §FR-052 requires the fan-out **count** to be visible; nothing in §US4 / §FR-051..FR-053 explicitly requires the just-sent **message body** to render in the sender's chat list. "the sender's UI shows" only refers to the count. | Add to §FR-052: "The just-sent message MUST be rendered immediately in the local participant's chat UI (local echo) with the fan-out count visible alongside it. The local-echo render MUST NOT depend on round-trip confirmation from any remote peer." | No |
| **CHK033** | Gap | §FR-041 forbids a room-level mutex/auto-stop/prompt but does not explicitly forbid introducing a `screen_share_busy` (or equivalent) error code into the contract. A future contract revision could introduce one without violating any current FR. | Add to §Non-Goals: "**No `screen_share_busy` (or equivalent) error code** in the signaling or chat contract. The application MUST NOT introduce any room-level screen-share busy concept; concurrent sharers (FR-041) are first-class behavior." | No |
| **CHK034** | Ambiguity (pedagogical) | The spec implies through FR-041's "no room-level mutex" that screen share is per-peer, but never makes the explicit pedagogical statement that **WebRTC has no native room-level "screen share" concept** — that screen share is purely an outgoing-track replacement at the local sender. This is a learning-outcome concept the feature exists to teach. | Add a learning-outcome bullet in §"Learning outcomes the feature MUST make explicit": "WebRTC has no native room-level concept of 'screen share'; screen share is per-peer outgoing-track replacement at each sender's RTCPeerConnection (FR-040, FR-043, EC-011)." | No |
| **CHK038** | **Conflict** | Reviewer's checklist requires a manual "reconnect-this-pair" affordance for failed peer-pairs. Spec §US7 AS#2 only offers "Leave / Remove" (which removes the failed tile, doesn't re-pair). Spec §Assumptions "No reconnection / no ICE restart" + §Non-Goals actively **rule it out**: "A failed peer-pair, a dropped signaling connection, or a refresh requires manual leave/rejoin in MVP." | **Decision required between two paths**: <br>(a) **Add reconnect-this-pair**: Add FR-025a + US7 AS#3 specifying a manual "Reconnect" affordance per failed peer-pair that creates a **fresh RTCPeerConnection** (not an ICE restart) for that pair; revise §Assumptions "No reconnection / no ICE restart" to "No automatic reconnect; manual per-pair reconnect via fresh PC IS in scope; no ICE restart". <br>(b) **Confirm out-of-scope**: leave the spec as is and update this checklist item / the reviewer's expectation to acknowledge the spec's deliberate stance (whole-session leave/rejoin is the only recovery). | **YES — affects failure semantics** |
| **CHK039** | Ambiguity (depends on CHK038) | If CHK038 (a) is chosen, the spec needs to explicitly say "reconnect = fresh PC, NOT `iceRestart: true` on the existing PC". §Non-Goals already excludes ICE restart, but the relationship between manual reconnect and ICE restart is undefined. | Resolved automatically by CHK038 (a) if chosen, with the wording in CHK038's fix. If CHK038 (b) is chosen, this item becomes moot. | YES via CHK038 |

### Summary by category

| Category | Pass | Fail | Notes |
|----------|------|------|-------|
| Learning intent | 4 / 5 | CHK004 | IDs missing |
| 001 coexistence | 4 / 5 | CHK010 | freeze flavor conflated |
| Mesh scope | 4 / 5 | CHK015 | codec selection missing |
| Mesh topology | 4 / 4 | — | clean |
| Pairwise negotiation | 4 / 5 | CHK023 | "no pause on join" implicit |
| Chat | 4 / 5 | CHK028 | local echo implicit |
| Screen sharing | 3 / 5 | CHK033, CHK034 | minor gaps |
| **Failure isolation** | **3 / 5** | **CHK038, CHK039** | **blocker — reconnect-this-pair conflict** |
| Observability | 7 / 7 | — | clean |
| Acceptance criteria | 7 / 7 | — | clean |
| **Total** | **44 / 53** | **9** | |

### Blocking decision

**CHK038** is the single blocker for `/speckit.plan` per your "block planning if the issue affects contract, room model, or failure semantics" rule. Pick path (a) or (b):

- **(a)** Reopen scope: add a manual reconnect-this-pair affordance (fresh PC) and revise §Assumptions / §Non-Goals to permit it. The signaling contract must then carry a `pair_reset` (or equivalent) message.
- **(b)** Confirm out-of-scope: keep the spec's current stance (whole-session leave/rejoin is the only recovery). Update the reviewer's checklist expectation accordingly; this checklist's CHK038 should then be reframed as "Is per-pair reconnect explicitly out of scope?" → would PASS.

The seven non-blocking failures (CHK004, CHK010, CHK015, CHK023, CHK028, CHK033, CHK034) are quality polish that can be applied in one small batch and do not gate planning, but the spec is stronger with them applied.

---

## Evaluation report — 2026-04-25 pass 2 (after reviewer pass 2 edits)

**Score**: **53 / 53 PASS** (100%). 0 FAIL. Spec is **plan-ready**.

### How each pass-1 failure was resolved

| ID | Pass-1 issue | Pass-2 resolution |
|----|--------------|-------------------|
| CHK004 | Learning outcomes lacked stable IDs | §"Mesh-specific learning outcomes (stable IDs L13–L18)" rewritten with 6 IDs (L13 per-PC independence, L14 fan-out cost, L15 failure isolation, L16 single video slot, L17 DataChannel fan-out, L18 newcomer pairing-order independence). SC-010 retargeted to L13–L18. |
| CHK010 | Behavior-vs-implementation freeze conflated | §Assumptions → "001 codepath untouched (behavioral freeze, not implementation freeze)" explicitly distinguishes the two. |
| CHK015 | Codec selection missing from Non-Goals | New Non-Goal: "No custom codec selection or codec preferences" (forbids `setCodecPreferences`). |
| CHK023 | "No pause on newcomer join" not explicit | New **FR-022a (Existing pair stability on newcomer join)** locks the invariant; surfaces as L18. |
| CHK028 | Local echo implicit | New **FR-052a (Chat local echo separated from per-channel send log)** — chat UI shows N=1, event log shows N − 1. |
| CHK033 | `screen_share_busy` not explicitly forbidden | New Non-Goal: "No `screen_share_busy` (or equivalent) error code". |
| CHK034 | "WebRTC has no room-level screen-share concept" implicit | Stated explicitly inside L16 plus reinforced in the new `screen_share_busy` Non-Goal. |
| CHK038 | reconnect-this-pair conflict (blocker) | Path (a) chosen. New **FR-026 (Manual reconnect-this-pair)** + new **US7 AS#3** + Assumption renamed to "No automatic reconnect / no ICE restart proper" + Non-Goal updated to allow manual per-pair reconnect via fresh PC. |
| CHK039 | Fresh-PC vs ICE-restart distinction | Resolved by FR-026 wording ("fresh pairing attempt, NOT an ICE restart") and tightened Non-Goal language. |

### New requirements added in pass 2

| New ID | Subject | Anchor section |
|--------|---------|----------------|
| **FR-013a** | State separation: local vs remote vs pair surfaces | §FR Mesh room & presence |
| **FR-021a** | Pair attempt identity (`pairEpoch` / equivalent) | §FR Pairwise WebRTC connections |
| **FR-022a** | Existing pair stability on newcomer join | §FR Pairwise WebRTC connections |
| **FR-026** | Manual reconnect-this-pair (fresh PC, not ICE restart) | §FR Pairwise WebRTC connections |
| **FR-052a** | Chat local echo separated from per-channel send log | §FR Group chat |

### Updated requirements in pass 2

| ID | Change |
|----|--------|
| FR-011 | "user-visible room-full error" (no bare `room_full` envelope type); v2 contract SHOULD prefer typed `join_rejected` |
| FR-032 | Direction locked to client→server→fan-out (server-side fan-out for media-state metadata; server still routes metadata only) |
| FR-060 | Added `peer pair reconnect requested`, `peer pair fresh attempt started` event-log entries |
| US7 AS#3 | New scenario covering manual Reconnect affordance with fresh-PC and stale-message rejection |
| SC-010 | Pegged to L13–L18 instead of "the nine learning outcomes" |
| §Assumptions | "001 codepath untouched" split into behavioral / implementation flavors; "No reconnection / no ICE restart" → "No automatic reconnect / no ICE restart proper" |
| §Non-Goals | Added codec selection, `screen_share_busy`; tightened ICE-restart language |
| §Clarifications | 10 new Q→A bullets recording each pass-2 decision |

### Plan-prompt emphasis (carry into `/speckit.plan`)

The plan must define:
- v2 mesh signaling contract (envelope versioning vs mesh namespace)
- room-full rejection shape (typed `join_rejected` over bare `room_full`)
- pair identity and `pairEpoch` / `pairAttemptId` for reconnect + stale-message rejection
- server-fan-out media-state semantics (one client → one server → N − 1 broadcasts)
- per-pair negotiation instruction message (when both peers reach `media-ready`)
- roster snapshot and ordered roster-update semantics (FR-012a, FR-012b)
- local-state vs remote-peer-state vs peer-pair-state separation surface
- DataChannel creator = lower-`admission_index` offerer (FR-050)
- chat local echo vs per-channel send log separation (FR-052a)
- reconnect-this-pair fresh-PC lifecycle (FR-026) — not ICE restart
- 001 regression boundary (behavioral, not code) and route preservation

## Notes

- Items above are **unit tests for the spec's English**, not for the implementation. A `[ ]` means the requirement is not yet adequately written; an `[x]` means the spec already meets the quality bar.
- Pass 2 (above) records full resolution. Re-evaluate again only if the spec is materially changed before `/speckit.plan`.
