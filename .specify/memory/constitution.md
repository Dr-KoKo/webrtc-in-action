<!--
SYNC IMPACT REPORT
==================
Version change: 1.0.0 → 2.0.0
Bump rationale: MAJOR. Principles were renumbered, renamed, and redefined; a new
principle (Specification-First Development) was added at position I, governance
rules were rewritten as rejection-based gates, and the project name/scope were
redefined (webrtc-lab, 1:1 MVP). These are backward-incompatible changes to
the constitution's principle set and governance surface.

Principle mapping (v1.0.0 → v2.0.0):
  (new)                                               → I.   Specification-First Development
  I.   Contract-First Signaling                        → II.  Contract-First Signaling (tightened)
  VIII. Separation of Signaling and Media Transport    → III. Separate Signaling from Media Transport (tightened, TURN-aware)
  III. Step-by-Step Incremental Delivery               → IV.  Incremental Vertical Slices (adds manual verification)
  IV.  Strong Observability & Debug Visibility         → V.   WebRTC Lifecycle Visibility (UI-visible, not just logs)
  II.  Explicit Failure & Edge-Case Handling           → VI.  Failure-Aware Design (enumerated WebRTC failures)
  VII. Security by Default for Browser RTC             → VII. Security by Default (honest scope)
  VI.  Protocol-Flow Testing (Not Just UI)             → VIII. Testing Discipline (protocol + contract + state)
  V.   Simple Architecture First, Extensibility Second → IX.  Simplicity with Extension Points (1:1 MVP, mesh/SFU-ready)

Added sections:
  - Additional Constraints (scope, stack neutrality, 1:1 MVP boundary)
  - Development Workflow & Quality Gates (rewritten around rejection gates)

Removed sections: none (prior sections were rewritten, not removed).

Templates requiring updates:
  - .specify/templates/plan-template.md         ⚠ pending — Constitution Check
      gate must reference Principles I–IX and reject plans proposing tech
      choices before the spec is clarified (Governance G-1).
  - .specify/templates/spec-template.md         ⚠ pending — add an explicit
      "Non-Goals" subsection (Principle I, Governance G-5); Assumptions section
      is already present.
  - .specify/templates/tasks-template.md        ⚠ pending — every generated
      task MUST carry a Definition of Done line (Governance G-2).
  - .specify/templates/checklist-template.md    ⚠ pending — generator must
      emit items for signaling contract presence, WebRTC log/verification
      path, and 1:1-vs-future-scope tagging (Governance G-3, G-4, G-5).
  - .specify/templates/commands/*.md            N/A — directory not present.
  - README.md / docs/quickstart.md              N/A — not present yet.

Follow-up TODOs: none deferred; all placeholders resolved.
-->

# webrtc-lab Constitution

`webrtc-lab` is a learning project that helps a backend-oriented developer
understand WebRTC by building a minimal, realistic 1:1 real-time communication
application (audio, video, chat, screen share). It is a toy in scope but
**not** a toy in discipline: every principle below is non-negotiable and
exists to keep WebRTC concepts **visible** rather than hidden behind glue code.

The project prioritizes, in order: protocol clarity, debuggability,
incremental learning. Feature richness is explicitly deprioritized.

## Core Principles

### I. Specification-First Development

Implementation MUST NOT begin before the relevant specification exists and is
clarified. Concretely:

- Requirements MUST be captured as a spec before any code is written for them.
- Any `[NEEDS CLARIFICATION]` marker or unanswered clarification question
  blocks technical planning for that spec.
- Every spec MUST include explicit **Non-Goals** to prevent scope creep.
- Every user-facing behavior MUST map to at least one acceptance criterion.

**Rationale:** The main risk in a learning project is accidentally skipping
the concept the project exists to teach. Writing the spec first forces the
learner to name what they are building before they get distracted by how.

### II. Contract-First Signaling

Every signaling message MUST be defined in a shared contract **before** any
producer or consumer is written. The contract MUST specify:

- message `type` (enumerated, not free-form),
- required fields and optional fields with types,
- error cases and error message shapes,
- contract version.

Frontend and signaling server MUST import/depend on the **same** contract
source. Ad-hoc JSON messages invented inside handlers are forbidden.

**Rationale:** Signaling drift between client and server is the single most
common source of silent WebRTC failure. A contract is the only honest way to
prevent it.

### III. Separate Signaling from Media Transport

The signaling server MUST only coordinate peers and relay signaling messages
(offer, answer, ICE, room membership, lifecycle). The signaling server MUST
NOT relay audio, video, or screen-share media. Media MUST flow peer-to-peer
through WebRTC. TURN MAY relay media **only** as a NAT-traversal fallback —
it MUST NOT be used as an application-level media router.

**Rationale:** Conflating signaling with media is the shortcut that makes a
project stop teaching WebRTC. Keeping them separated keeps the protocol
honest and keeps the learning surface intact.

### IV. Incremental Vertical Slices

Work MUST proceed as small, runnable milestones. Each milestone:

- MUST deliver an end-to-end slice the learner can run in a browser,
- MUST have a written **Definition of Done**,
- MUST include **manual verification steps** (what to click, what to see,
  what log lines to expect).

Generating the full application in one implementation pass is prohibited.

**Rationale:** WebRTC has stages (signaling → ICE → DTLS → SRTP → media).
Learning happens per stage. One-shot implementations skip the learning.

### V. WebRTC Lifecycle Visibility

The UI MUST surface WebRTC lifecycle state without requiring browser devtools.
At minimum, the learner MUST be able to see: `RTCPeerConnection`
`connectionState`, `iceConnectionState`, `iceGatheringState`, `signalingState`,
track/media state (local and remote), and a timeline of major events (join,
offer sent, answer received, ICE candidate added, connected, disconnected,
leave). Logs are a **first-class learning feature**, not a debugging
afterthought.

**Rationale:** If you cannot see the state machine, you cannot learn it.

### VI. Failure-Aware Design

The following failure cases MUST be specified and tested (or explicitly
deferred with a written justification):

- camera / microphone permission denial,
- peer joins first and waits for the second peer,
- peer joins when another peer is already present,
- a third peer attempts to join a 1:1 room,
- ICE connection failure,
- peer refreshes the page,
- peer closes the tab without a graceful leave,
- screen sharing stopped from the browser's native UI,
- WebSocket signaling disconnect.

Error states MUST be user-visible. Where practical, they MUST be recoverable
(e.g., reconnect on WebSocket drop) rather than silently fatal.

**Rationale:** A demo that only works on the happy path teaches the happy
path, which is the part of WebRTC you did not need to learn.

### VII. Security by Default

- Browser secure-context requirements (HTTPS, secure origin) MUST be
  documented per feature that needs them.
- Any non-`localhost` deployment MUST use HTTPS/WSS. Plain HTTP/WS is only
  permitted on `localhost` under browser secure-context exceptions.
- No secrets (TURN credentials, API keys, session tokens) may be hardcoded
  in the client bundle or committed to the repo.
- The system MUST NOT claim or imply end-to-end security properties it does
  not actually implement. If E2EE is not implemented, documentation MUST say
  so plainly.

**Rationale:** Browser real-time code touches camera and microphone. Honest,
boring defaults beat clever ones.

### VIII. Testing Discipline

Tests MUST protect the protocol, not just the pixels. Required coverage:

- **Protocol flow tests** exercising join → offer → answer → ICE → connected
  → chat → screen share → leave (and at least one failure path).
- **Server room state** unit tests for every state transition (empty →
  waiting → paired → full-rejection → peer-left).
- **Signaling contract validation** tests (rejects malformed messages;
  accepts valid ones for every declared type).
- **Manual browser-to-browser verification steps** written down for each
  milestone (two browsers, two tabs, or two machines).

A passing UI snapshot is NOT evidence that the call works.

**Rationale:** The protocol is the product. UI that renders over a broken
call is still a broken call.

### IX. Simplicity with Extension Points

The MVP MUST remain strictly 1:1. Room and peer models MUST NOT implement
multi-party behavior, but MUST NOT structurally block a future migration to
mesh or SFU (e.g., peer identity is not hard-coded to exactly two slots in a
way that requires rewriting the model to add a third). Premature abstractions
(plugin systems, event buses, generic `Transport` interfaces with one
implementation) are forbidden. An extension point is justified only by a
concrete, near-term learning or maintainability benefit — "we might need it
later" is not sufficient.

**Rationale:** Complexity that is bought up-front in a learning project
usually pays interest before it pays dividends, and obscures the very
concepts the project exists to teach.

## Additional Constraints

- **Scope boundary (MVP):** 1:1 room, one signaling server, one client
  application, features limited to audio, video, text chat, and screen share.
  Anything beyond 1:1 is non-MVP and MUST be tagged as such.
- **Stack neutrality:** This constitution does not prescribe a specific
  language, framework, or library. Tech choices belong in the plan, subject
  to Governance rule G-1.
- **Transport defaults:** Signaling default is WebSocket over TLS (WSS).
  STUN/TURN configuration MUST live in environment/config, never in code.
- **Privacy default:** No media is recorded, forwarded, or persisted. Any
  feature that records or stores media MUST be flagged in its spec and
  gated behind explicit user consent UI.
- **Target surface:** Modern evergreen browsers (Chromium, Firefox, Safari,
  current and current-1). Non-browser WebRTC stacks are out of scope.

## Development Workflow & Quality Gates

1. **Specify → Clarify → Plan → Tasks → Implement.** Each phase's artifacts
   are prerequisites for the next.
2. **Clarify-before-plan.** `/speckit.plan` MUST NOT run while the spec
   contains unresolved `[NEEDS CLARIFICATION]` markers (Governance G-1).
3. **Constitution Check gate.** Every plan's Constitution Check MUST
   evaluate Principles I–IX. Violations MUST be recorded in Complexity
   Tracking with justification; unjustified violations block the plan.
4. **Definition of Done on every task.** Every task MUST state its DoD —
   acceptance met, protocol/contract tests passing, logs/UI visibility
   hooks present, manual verification steps executable (Governance G-2).
5. **Review surface.** Code review MUST explicitly verify: contract is
   referenced for every signaling message, WebRTC behavior has a visible
   log or verification path, signaling and media remain separated,
   security defaults intact, and scope is within 1:1 MVP (or explicitly
   tagged non-MVP).

## Governance

This constitution supersedes ad-hoc conventions. When guidance conflicts with
this document, this document wins until amended.

- **G-1 — Reject premature technology choices.** A plan that fixes
  technology choices (language, framework, library, protocol extensions)
  before the spec it depends on is clarified MUST be rejected and
  regenerated.
- **G-2 — Reject tasks without a Definition of Done.** Any task without an
  explicit DoD MUST be rejected and rewritten before implementation starts.
- **G-3 — Reject undocumented signaling messages.** Any signaling message
  (sent or received) that lacks a documented contract entry MUST be
  rejected in review. New messages require a contract change first.
- **G-4 — Reject invisible WebRTC behavior.** Any WebRTC behavior (state
  transition, negotiation step, media event) without a visible log, UI
  indicator, or documented manual verification path MUST be rejected.
- **G-5 — Guard the 1:1 MVP boundary.** Any scope expansion beyond 1:1
  communication MUST be explicitly marked as non-MVP in the spec. Code
  that introduces multi-party semantics into the MVP codepath MUST be
  rejected.
- **Amendment procedure.** Amendments are proposed by PR to this file,
  accompanied by (a) the rationale, (b) the version bump with type
  (MAJOR / MINOR / PATCH), and (c) a Sync Impact Report listing every
  template or doc that must change. Amendments take effect on merge.
- **Versioning policy.** Semantic versioning applies to this constitution:
  **MAJOR** for backward-incompatible governance or principle
  removal/redefinition; **MINOR** for new principles/sections or
  materially expanded guidance; **PATCH** for clarifications, wording,
  and non-semantic fixes.
- **Compliance review.** Every PR description MUST state which principles
  it touches and confirm Constitution Check passed. Reviewers MUST block
  merge on any unjustified violation or any G-1..G-5 trigger.

**Version**: 2.0.0 | **Ratified**: 2026-04-19 | **Last Amended**: 2026-04-19
