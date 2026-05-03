# Feature Specification: SFU Learning Room

**Feature Branch**: `003-webrtc-sfu-room`
**Created**: 2026-05-03
**Status**: Draft
**Input**: User description: "SFU Learning Room — add a separate SFU mode (capacity 4) at `/sfu/:roomId` alongside the preserved 001 1:1 mode and 002 mesh mode, so a learner can directly compare 1:1, mesh, and SFU topologies; observe the browser↔SFU media path, publisher/subscriber model, uplink fan-out reduction, and SFU-specific failure domains; and understand what changes when topology moves from peer-to-peer mesh to a server-mediated forwarding unit."

## Purpose & Learning Intent *(mandatory for this project)*

This feature is the **third learning milestone** of the `webrtc-in-action`
learning project. It is **not** a replacement for the 001 1:1 baseline or
the 002 mesh mode; both modes MUST remain intact and shippable. Instead,
this feature adds a **separate SFU mode** that lives alongside the 1:1 and
mesh modes, so a learner can run all three modes in the same application
and directly compare how WebRTC behaves when media transport moves from
peer-to-peer (1:1, mesh) to server-mediated forwarding (SFU).

### Constitutional alignment (Principle IX, Principle III, Principle VII, Governance G-5)

Constitution v2.0.0 ratifies a strictly 1:1 MVP and Principle IX explicitly
preserves "extension points" for "a future migration to mesh or SFU". The
002 mesh mode realized the mesh extension point; this feature realizes the
**SFU extension point** as the next learning expansion in a **separate
codepath**.

In G-5 terms: this feature does **NOT** introduce SFU semantics into the
001 1:1 codepath or the 002 mesh codepath. The 001 room model continues to
enforce two reserved slots, third-peer rejection, and all 001 acceptance
criteria. The 002 mesh codepath continues to enforce its 4-participant
mesh, per-pair lifecycle, and all 002 acceptance criteria. The SFU
codepath is an additive, opt-in **learning mode beyond the original 001
MVP**: it is the MVP scope of feature 003 specifically, not part of the
001 MVP scope. "MVP" later in this document refers to the 003 MVP unless
otherwise qualified.

**Principle III (Separate Signaling from Media Transport) — scoped
divergence in SFU mode only.** Principle III requires that the signaling
server MUST NOT relay audio, video, or screen-share media. In 1:1 (001)
and mesh (002), this rule is enforced in full and remains unchanged. In
SFU (003), the **SFU media component** is a server-side WebRTC endpoint
that DOES receive and forward media packets — that is the entire
educational point of the mode (see L19, L21, L23). This divergence is
confined to the SFU codepath:

- 001 and 002 server code MUST NOT receive or forward media (unchanged).
- The SFU media component MUST live in
  `signaling/internal/modes/sfu/mediafabric/` as an in-process Go
  package (DD-001 = A, FR-091) and MUST NOT be importable from the 001
  or 002 codepaths.
- Per Principle VII (Honest Scope), the SFU spec, UI, and contract MUST
  truthfully describe that media flows browser↔SFU and that the SFU is
  a WebRTC participant from each browser's perspective. The UI MUST NOT
  imply browser↔browser media in SFU mode.
- The MVP makes **no end-to-end encryption claim** for SFU media: media
  credentials are accessible to the SFU media component for routing
  purposes (see NFR-003 and Non-Goals).

### Primary learning goal

Teach how WebRTC behaves when topology moves from a peer-to-peer mesh
(N participants, N×(N−1)/2 peer-pairs, O(N²) cost) to a **selective
forwarding unit** topology where each participant has a small, constant
number of WebRTC connections to a server-side media component, the
server forwards published media to every other participant's subscriber
state, and the room can grow without N²-scaling of browser↔browser
peer-pairs.

### SFU-specific learning outcomes (stable IDs L19–L25)

The running SFU mode MUST let a learner directly observe and reason
about each of the following. Each outcome MUST have at least one
observable moment in the UI or event log (per SC-S03). The original
001 learning outcomes (referred to as L1–L12) remain reachable through
the preserved 001 mode (FR-002, US2 AS#5, SC-S06). The mesh-specific
learning outcomes (L13–L18) remain reachable through the preserved 002
mode (FR-003, US2 AS#5, SC-S06).

- **L19 — SFU media path**: Each browser sends media to the SFU and
  receives forwarded media from the SFU; the media path is **browser↔SFU,
  not browser↔browser**. Observable surfaces:
  - media-path label / diagram explicitly naming "browser ↔ SFU" on
    every remote tile and in the SFU learning panel (FR-046, FR-074);
  - browser↔SFU `connectionState` indicators per local SFU transport
    (FR-064);
  - "SFU media forwarded" event-log entries scoped to the SFU
    (FR-061, FR-062);
  - cost summary listing **server media role = forwarding** (FR-070).

- **L20 — Uplink fan-out reduction**: In mesh, each participant sends
  `N − 1` outgoing media copies (one per remote peer-pair). In SFU,
  each participant uploads **one copy of each published track to the
  SFU**, regardless of how many other participants subscribe to it.
  Observable surfaces:
  - SFU cost summary `uplink copies per published track` (FR-070,
    NFR-009);
  - side-by-side comparison of mesh and SFU cost summaries at N=4
    (US2, SC-S02);
  - uplink-copies count remaining constant as additional subscribers
    join (US2 AS#3, SC-S02).

- **L21 — Server-side WebRTC endpoint**: The SFU media component is
  a **WebRTC participant** from each browser's perspective. Offer/answer
  exchange, ICE negotiation, DTLS/SRTP transport setup, and
  RTCPeerConnection state all exist between **browser and SFU**, not
  between browser and browser. Observable surfaces:
  - per-Constitution-Principle-V lifecycle indicators (`connectionState`,
    `iceConnectionState`, `iceGatheringState`, `signalingState`)
    surfaced for each local SFU transport (FR-022, FR-064);
  - event log entries identifying the **SFU** as the negotiation
    counterpart on every "offer created", "answer received", "ICE
    candidate sent/received", "connection state changed" event
    (FR-061);
  - learning inspector summarizing the SDP media sections, ICE
    candidate types, and STUN/TURN configuration of the local SFU
    transport (FR-072).

- **L22 — Publisher/subscriber model**: A participant **publishes**
  local media tracks to the SFU and **subscribes** to remote tracks
  through the SFU. The two roles are observable as distinct state.
  Observable surfaces:
  - local UI distinguishes "published local tracks" from "subscribed
    remote tracks" (FR-040, FR-041, FR-051);
  - event log distinguishes "media publish started/stopped" from
    "remote subscription added/removed" (FR-061, FR-062);
  - SFU learning panel labels each track as either an outgoing
    publication or an incoming subscription (FR-074).

- **L23 — RTP forwarding without application media recording**:
  The SFU media component forwards media packets / tracks for routing
  only. The application MUST NOT record, persist, or otherwise store
  media. The UI MUST NOT imply that media remains peer-to-peer in
  SFU mode. Observable surfaces:
  - SFU learning panel statement that the SFU "forwards media packets
    between participants and does not record or persist them"
    (FR-074, NFR-003);
  - server-side media component scope confined to forwarding (FR-091,
    NFR-008);
  - explicit non-goal: "no recording" (Non-Goals, NFR-003).

- **L24 — SFU vs mesh cost comparison**: A learner running both
  `/mesh/:roomId` and `/sfu/:roomId` at N=4 can compare topology and
  cost summaries side by side. Observable surfaces:
  - mesh cost summary (FR-070 from 002): local PC count = `N−1` = 3,
    room peer-pairs = `N×(N−1)/2` = 6, outgoing senders =
    `2×(N−1)` = 6, server media role = none (signaling-only);
  - SFU cost summary (FR-070): local SFU transport count = **1**
    per participant (DD-002 = A), uplink copies per published
    track = 1, outgoing senders = 2 per fully-publishing
    participant (audio + video; screen replaces video source
    rather than adding a sender, DD-004 = A), subscribed remote
    participant count = `N−1`, downstream forwarding deliveries
    per published track = `N−1`, downstream forwarding deliveries
    from this participant = activePublishedTrackCount × `N−1`,
    server media role = forwarding (SFU), participant count = N;
  - SFU learning panel cross-mode summary table (FR-074, US2,
    SC-S02);
  - reachability via the existing mode badge / route navigation
    (FR-004).

- **L25 — SFU failure domains**: Failure is no longer per
  browser↔browser pair as in mesh. SFU failures occur on:
  (a) the local browser↔SFU transport,
  (b) a single published track,
  (c) a single subscribed remote track, or
  (d) the SFU media component itself.
  The UI MUST distinguish these failure modes from each other and
  from mesh-style per-pair failure. Observable surfaces:
  - per-local-SFU-transport failure indicator distinct from
    per-published-track and per-subscribed-track indicators (FR-080,
    FR-081, FR-082);
  - room-level "SFU unavailable" indicator distinct from
    "browser↔SFU transport failed" (FR-083, US7 AS#4);
  - event log scoping every failure to the correct domain
    (publisher / subscriber / SFU transport / SFU component;
    FR-061, FR-062);
  - explicit absence of mesh-style "peer-pair failed" semantics
    in SFU mode (FR-046, NFR-005).

## Resolved Architectural Decisions

The following architectural decisions were resolved by the **2026-05-03
clarify pass** (see §Clarifications → "Session 2026-05-03 (Clarify
pass)" for the Q/A record). The plan MUST treat these as canonical and
MUST NOT reopen them. Each entry retains the original `DD-NNN`
identifier for downstream traceability and now records the locked
choice plus the candidates that were explicitly NOT chosen.

- **DD-001 — SFU media-plane placement** — **RESOLVED 2026-05-03 (Option A)**.
  The SFU media component lives **in-process** in the existing Go
  signaling binary as a `mediafabric` package under
  `signaling/internal/modes/sfu/mediafabric/`. Docker Compose topology
  is unchanged from 001/002 (single signaling service). Cross-mode
  isolation (NFR-008) is enforced by package boundaries plus the
  extended `scripts/audit-boundaries.sh` (NFR-006). Other candidates
  (separate local SFU service; external SFU product/library wrapper)
  are explicitly NOT chosen for the MVP.

- **DD-002 — Browser↔SFU WebRTC topology** — **RESOLVED 2026-05-03 (Option A)**.
  Each participant maintains **exactly one bidirectional
  `RTCPeerConnection`** to the SFU. The single PC carries both publish
  (camera + microphone sendonly transceivers, plus any DD-004
  screen-share publication) and subscribe (recvonly transceivers added
  per subscribed remote track). Subscriber add/remove triggers
  renegotiation on this single PC. Other candidates (separate
  publisher/subscriber PCs; WHIP-style asymmetric topology) are
  explicitly NOT chosen for the MVP.

- **DD-003 — Chat in SFU mode** — **RESOLVED 2026-05-03 (Option A)**.
  Chat is **omitted** from the SFU MVP. The SFU UI MUST NOT display
  a chat panel; the SFU event log MUST NOT include chat-related
  entries; the v3 contract MUST NOT include chat message types.
  Pairwise (001) and mesh (002) DataChannel chat remain reachable
  via their own routes unchanged. Other candidates (signaling-
  relayed room chat; SFU-mediated DataChannel forwarding) are
  explicitly NOT chosen for the MVP.

- **DD-004 — Screen share in SFU MVP** — **RESOLVED 2026-05-03 (Option A)**.
  Screen share IS included in the SFU MVP, implemented as published
  video-source replacement on the participant's existing video sender
  (`RTCRtpSender.replaceTrack`). Each participant has exactly **one
  outgoing video slot**; starting screen share replaces that slot's
  track. No additional published video track, no additional video
  sender, and no additional video transceiver are created;
  existing subscriber forwarding paths carry the participant's
  current video source (camera or screen). No renegotiation is
  required for the source swap. Multiple participants MAY
  screen-share concurrently; the application MUST NOT enforce a
  room-level single-sharer mutex. US6 priority is **P2**. Other
  candidates (defer entirely; camera/mic only) are NOT chosen for
  the MVP.

- **DD-005 — SFU media inspection depth in the learning inspector**
  — **RESOLVED 2026-05-03 (Option B)**.
  The learning inspector surfaces **derived summaries** of
  forwarding / track metadata (per-PublishedTrack forwarding-
  delivery counts, per-SubscribedTrack origin label, per-track
  kind and source label) **plus** the SDP m-line / ICE-candidate-
  type / STUN-TURN summaries already required by FR-072. NFR-004
  remains in force for **rendering and logging**: no raw RTP
  payloads, no rendered raw SDP strings, no rendered raw ICE
  candidate strings, no TURN credentials in UI / event log /
  inspector / application logs. The v3 contract MAY transmit raw
  SDP offer/answer and raw ICE candidate payloads on the wire
  (FR-090) because they are required for WebRTC negotiation, and
  also carries the SFU-computed inspector summaries. Other
  candidates (high-level prose only; raw RTP/SDP rendered debug
  view) are explicitly NOT chosen for the MVP.

Each `DD-NNN` reference appears inline in this spec where a downstream
requirement, user story, edge case, or success criterion depends on
the deferred decision.

## Clarifications

### Session 2026-05-03

The following decisions were locked by the feature author before
specification. Each is integrated into the relevant requirement,
acceptance scenario, edge case, or assumption elsewhere in this
document; this section is the canonical record of the decision itself.

- Q: Is this feature a replacement for 001 or 002? →
  A: **No.** SFU is an additive, separate mode. Both the 001 codepath
  and the 002 codepath remain intact and shippable. (See FR-001,
  FR-002, FR-003, NFR-005, and Non-Goals.)
- Q: What is the SFU room capacity in MVP? →
  A: **Exactly 4 participants.** This matches mesh capacity (002 FR-011)
  so the learner can compare mesh and SFU at the same participant count
  (US2, L24, SC-S02). A 5th participant is rejected with a structured
  room-full result (FR-011, US1 AS#4). Configurable capacity is out of
  scope for the MVP. (See FR-011, US1, US2, and Assumptions.)
- Q: What route and signaling endpoint does SFU mode use? →
  A: Frontend route **`/sfu/:roomId`** and signaling endpoint **`/ws/sfu`**.
  The existing 001 endpoint `/ws` and 002 endpoint `/ws/mesh` MUST remain
  unchanged. (See FR-002, FR-003, FR-010, FR-090, NFR-005.)
- Q: What signaling contract version applies to SFU mode? →
  A: A new **v3 signaling contract** scoped to `/ws/sfu`. The 001 v1
  contract scoped to `/ws` and the 002 v2 contract scoped to `/ws/mesh`
  remain frozen and MUST NOT be changed by this feature. v3 is additive
  to the project's signaling-contract surface; v1 and v2 messages MUST
  NOT appear on `/ws/sfu` and v3 messages MUST NOT appear on `/ws` or
  `/ws/mesh`. (See FR-090, NFR-005.)
- Q: Is the SFU media component allowed to handle media? →
  A: **Yes, in SFU mode only.** The SFU media component is a server-side
  WebRTC endpoint that receives and forwards media packets / tracks for
  routing; this is the entire educational point (L19, L21, L23). 001 and
  002 server code MUST NOT receive or forward media. The SFU media
  component MUST be isolated to the SFU mode codepath. (See
  §Constitutional alignment, FR-091, NFR-003, NFR-008, Non-Goals.)
- Q: How does the running app distinguish SFU mode from 1:1 and mesh? →
  A: A clear, persistent, always-visible UI indicator (e.g., header badge
  "SFU mode (capacity 4)") that is visually distinguishable from the 1:1
  and mesh badges at a glance. (See FR-004 and US2.)
- Q: Lifecycle visibility — which RTCPeerConnection states does SFU
  surface per local SFU transport? →
  A: All four states required by Constitution Principle V —
  `connectionState`, `iceConnectionState`, `iceGatheringState`,
  `signalingState` — MUST be visible per local SFU transport (in the
  always-on indicators of FR-064 and as transitions in the FR-061 event
  log). The exact decomposition into "transport count per participant"
  depends on DD-002. (See FR-022, FR-064, FR-061.)
- Q: Must lifecycle visibility work without browser devtools? →
  A: **Yes.** The UI MUST expose current state and event logs without
  requiring the learner to open browser devtools. SFU MUST be
  understandable by running the app, not by reading source code only.
  (See FR-060, FR-064, NFR-009.)
- Q: How is each browser↔SFU WebRTC transport-negotiation message
  disambiguated from earlier failed attempts? →
  A: Every browser↔SFU **transport-negotiation** attempt MUST carry
  a transport-attempt identifier scoped to the participant's single
  SFU transport (DD-002 = A; analogous to 002's pair-attempt
  identifier per peer-pair, but scoped to the one browser↔SFU
  transport rather than per-pair because SFU mode has no peer-pair).
  The exact wire format is a contract decision (FR-090 (a)); the
  spec only requires that some such mechanism exists and is checked
  before applying any transport-negotiation message (offer / answer
  / ICE candidate / reconnect / renegotiation) on `/ws/sfu`.
  Participant- / track-level metadata messages (e.g. media-state
  per FR-033) are NOT transport-negotiation messages and MUST NOT
  carry the transport-attempt identifier (FR-090 (a),
  Key Entities → SignalingMessageV3). (See FR-090, FR-026.)
- Q: Are the SFU cost summary, learning inspector, and per-track
  indicators production telemetry? →
  A: **No.** They are **learning indicators only** — not alerting,
  aggregation, or longitudinal-analysis signals. The MVP MUST NOT emit
  metrics to external monitoring systems. (See NFR-009 and Non-Goals.)
- Q: Does the MVP include simulcast/SVC, codec selection UI, recording,
  Insertable Streams E2EE, production TURN automation, autoscaling SFU
  cluster, multi-room distributed state, production monitoring stack,
  mobile native apps, file transfer, global chat ordering, or
  production security claims? →
  A: **No** for all. (See Non-Goals and NFR-010.)
- Q: How is the room ID validated for SFU mode? →
  A: The same rule as 001 and 002: room IDs MUST be **trimmed before
  validation**, **case-sensitive**, **1–64 characters**, containing
  only printable ASCII letters / digits / hyphen / underscore / dot
  (`[A-Za-z0-9._-]`). Invalid IDs MUST be rejected by both client and
  server. (See FR-010, EC-013.)
- Q: What does "SFU media component unavailable" mean from the
  participant's perspective, and is it distinct from "my browser↔SFU
  transport failed"? →
  A: **Yes, distinct.** A local browser↔SFU transport failure affects
  only the local participant's published/subscribed tracks. An SFU
  media component failure affects all participants in the room. The
  UI MUST distinguish these two failure modes (L25, FR-080, FR-083,
  US7). The SFU MUST NOT be silently presented as a peer that "left".
- Q: How is "ungraceful disconnect" split between local and remote
  viewpoints in SFU mode? →
  A: Two distinct success criteria:
  - **SC-S04 (remote-session-ended)** — from remaining participants'
    viewpoint, the gone participant transitions to `left` within
    10 seconds and only that participant's remote tile and
    subscriptions are removed;
  - **SC-S04b (local-signaling-loss)** — from the dropping client's
    own viewpoint, a `signaling-error` is surfaced within 5 seconds;
    already-established browser↔SFU media may continue carrying media
    until it fails on its own.
  EC-010 is the local-viewpoint edge case; SC-S04 / SC-S04b name the
  measurable outcomes for each viewpoint.
- Q: Are SFU-specific learning outcomes assigned stable IDs for
  traceability? →
  A: **Yes** — seven outcomes **L19–L25** in §"SFU-specific learning
  outcomes". 001 outcomes (treated as L1–L12) remain reachable through
  the preserved 001 mode; mesh outcomes (L13–L18) remain reachable
  through the preserved 002 mode. SC-S03 pegs reviewer-walkthrough
  coverage to L19–L25. (See §SFU-specific learning outcomes,
  §Success Criteria.)
- Q: What still needs `/speckit.clarify` to answer before planning? →
  A: All five deferred decisions DD-001..DD-005 (see §Deferred
  Decisions) were **resolved on 2026-05-03** in §"Session 2026-05-03
  (Clarify pass)" below. The spec is ready for `/speckit.plan`. One
  residual choice — whether to expose a manual per-transport
  Reconnect button or restrict recovery to leave/rejoin only — is
  scoped by FR-026 to "no automatic reconnect"; the leave/rejoin vs.
  manual-reconnect-button choice is a UI-affordance decision deferred
  to /speckit.plan.

### Session 2026-05-03 (Clarify pass)

- Q: DD-001 — Where does the SFU media component live in the running
  system? → A: **In-process Go `mediafabric` package under
  `signaling/internal/modes/sfu/mediafabric/`** (Option A). Single
  binary; the entire media path is readable in this repo alongside the
  v3 signaling code; isolated from 001/002 by the per-mode package
  boundary. Implementing a minimal forwarder ourselves is bounded by
  the 4-participant capacity (FR-011), no simulcast/SVC (NFR-010), and
  no production claims (NFR-003). (See FR-091, NFR-008,
  §Constitutional alignment, Key Entities → SFUMediaComponent.)
- Q: DD-002 — How many RTCPeerConnections does a participant maintain
  to the SFU? → A: **One bidirectional `RTCPeerConnection` per
  participant** (Option A). The single PC carries both publish (camera
  + microphone sendonly transceivers, plus any DD-004 screen-share
  publication) and subscribe (one recvonly transceiver per
  subscribed remote track). Each participant therefore has **exactly
  one local SFU transport** (not `N − 1` as in mesh). Adding or
  removing a remote participant triggers an SDP renegotiation on this
  single PC; for N=4 that is at most 3 renegotiations per join. (See
  FR-013, FR-020, FR-022, FR-064, FR-070, Key Entities → Participant /
  SFUTransport, EC-009.)
- Q: DD-004 — Is screen share included in the SFU MVP, and if so
  how? → A: **Yes — included as published video-source replacement
  via `RTCRtpSender.replaceTrack` on the participant's existing
  video sender** (Option A). This mirrors 002 mesh's single-
  outgoing-video-slot rule (002 FR-040, L16) so the learner sees
  that screen share works the same way at the publisher boundary
  in both modes, while the uplink fan-out cost (L20) still differs.
  Each participant has exactly **one outgoing video slot**; starting
  screen share replaces that slot's track on the SFU sender. No
  additional published video track, no additional video sender,
  and no additional video transceiver are created; existing
  subscriber forwarding paths carry the participant's current
  video source. No renegotiation is required for the source swap.
  Multiple participants MAY screen-share concurrently. The
  application MUST NOT enforce a room-level single-sharer mutex.
  US6 stays at priority P2. (See FR-032, FR-041, FR-042, FR-070,
  US6, Key Entities → PublishedTrack / Publisher.)
- Q: DD-003 — Does SFU mode include any chat surface, and if so
  what carries it? → A: **No — chat is omitted from the SFU MVP**
  (Option A). 001 already teaches pairwise `RTCDataChannel` chat
  (L1–L12) and 002 already teaches mesh DataChannel fan-out chat
  (L17); adding a chat surface to SFU mode would either duplicate
  signaling-relayed work or pull a server-side DataChannel-forwarding
  feature into the SFU media component (DD-001), neither of which
  appears in L19–L25. The SFU UI MUST NOT display a chat panel; the
  SFU event log MUST NOT include chat-related entries; the v3
  contract MUST NOT include chat message types. Pairwise and mesh
  DataChannel chat remain reachable via 001 and 002 routes
  unchanged. (See EC-015, Non-Goals, FR-002, FR-003, FR-062, FR-090.)
- Q: DD-005 — How much server-side media metadata does the learning
  inspector surface? → A: **Derived summaries of forwarding /
  track metadata** (Option B), with NFR-004 still in force (no raw
  RTP payloads, no rendered raw SDP strings, no rendered raw ICE
  candidate strings, no TURN credentials in UI / event log /
  inspector / application logs). Concretely the learning inspector
  MUST surface: per-PublishedTrack forwarding-delivery summary
  (e.g. "1 inbound source observed at the SFU, forwarded to `N − 1`
  subscriber deliveries"), per-SubscribedTrack origin label (which
  remote participant the subscription comes from), per-track kind
  (audio / video) and current source label (microphone / camera /
  screen, per DD-004), and the SDP m-line / ICE-candidate-type /
  STUN-TURN summaries already required by FR-072. The v3 contract
  MAY carry raw SDP offer/answer and raw ICE candidate payloads on
  the wire because they are required for browser↔SFU WebRTC
  negotiation; NFR-004 governs **rendering and logging** of those
  payloads, not their transmission as signaling payloads. The v3
  contract MUST also carry the SFU-computed inspector summaries so
  the client can render them. Raw RTP and TURN credentials MUST
  NOT be transmitted at all. (See FR-072, FR-074, FR-090, NFR-004,
  EC-016, L19, L20, L22.)

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Join an SFU room and see/hear other participants (Priority: P1)

A participant opens `/sfu/demo`, joins the room, grants camera and
microphone, and publishes local media to the SFU. As other participants
join the same SFU room (up to capacity 4), each participant sees and
hears the others through SFU-forwarded media. A 5th participant is
rejected with a structured room-full result.

**Why this priority**: This is the minimum SFU experience that proves
the room admission, browser↔SFU media path, publisher/subscriber
plumbing, and capacity bound all work end to end. Without it, no other
SFU learning outcome (L19–L25) can be observed.

**Independent Test**:
1. Open `/sfu/demo` in browser A; grant camera/mic; verify Alice enters
   a waiting/publishing state and the SFU mode badge is visible
   (FR-004).
2. Open `/sfu/demo` in browser B; grant camera/mic; verify Alice and
   Bob each see one remote tile and hear the other through
   SFU-forwarded audio (FR-046, FR-051).
3. Open browsers C and D on `/sfu/demo`; verify all four participants
   see three remote tiles and hear three remote audio streams each
   (FR-011, FR-051).
4. Open a 5th browser on `/sfu/demo`; verify the 5th browser receives a
   structured room-full result and the four-person room continues
   uninterrupted (FR-011, US1 AS#4).

**Acceptance Scenarios**:

1. **Given** no participant is in `/sfu/demo`, **When** Alice opens
   `/sfu/demo` and grants camera/mic, **Then** Alice enters a
   waiting/publishing state in which her local published tracks are
   acknowledged by the SFU and her UI explicitly indicates "waiting
   for other participants" without showing remote tiles.
2. **Given** Alice is the only participant in `/sfu/demo` (in the
   waiting state), **When** Bob opens `/sfu/demo` and grants
   camera/mic, **Then** within 10 seconds both Alice and Bob see and
   hear each other through SFU-forwarded media, each remote tile is
   labeled "via SFU" (or equivalent media-path label per FR-046),
   and the event log on each side records "remote subscription
   added" for the other participant (FR-061).
3. **Given** Alice, Bob, and Carol are in `/sfu/demo`, **When** Dan
   opens `/sfu/demo` and grants camera/mic, **Then** within 10
   seconds all four participants see and hear the other three; each
   participant's roster shows three remote participants; no existing
   participant's `connectionState` or `iceConnectionState` indicator
   regresses (i.e. existing `connectionState=connected` indicators do
   not flip back to `connecting`) solely because Dan joined. Each
   existing participant's `signalingState` MAY transition through
   the expected renegotiation cycle (e.g. `stable` →
   `have-local-offer` → `stable`) to add the recvonly transceiver
   subscribing to Dan; this is expected and visible in FR-064
   indicators (FR-025).
4. **Given** Alice, Bob, Carol, and Dan are in `/sfu/demo`, **When**
   a 5th browser attempts to join `/sfu/demo`, **Then** the 5th
   browser receives a structured room-full result (FR-011), no
   media or remote tile is established for the 5th browser, and the
   four-person room continues uninterrupted (no roster change for
   the existing four participants).
5. **Given** Alice has granted camera/mic and joined `/sfu/demo`,
   **When** Alice closes the tab, **Then** within 10 seconds the
   remaining participants see Alice's tile removed and Alice's
   subscriptions torn down on their side (FR-082, SC-S04).

---

### User Story 2 — Compare 1:1, mesh, and SFU topology costs (Priority: P1)

A learner opens 1:1 mode at `/`, mesh mode at `/mesh/demo`, and SFU
mode at `/sfu/demo` (each with the appropriate participant count for
that mode) and uses the cost summary panel and mode badge to compare
local PC count, outgoing sender count, room peer-pair count, server
media role, and topology shape across all three modes.

**Why this priority**: This is the comparison that justifies why an
SFU exists. Without this side-by-side reachability, L20 (uplink
fan-out reduction) and L24 (SFU vs mesh cost comparison) cannot be
observed in the running app, only described in prose. A learner
should be able to flip between mode badges and read the cost summary
without leaving the app.

**Independent Test**:
1. Bring up the stack via `docker compose up --build` and verify all
   three routes are reachable: `/`, `/mesh/demo`, `/sfu/demo`
   (FR-002, FR-003).
2. In mesh mode at N=4, read the mesh cost summary (002 FR-070):
   confirm local PC count = 3, room peer-pairs = 6, outgoing
   senders = 6 (`2×(N−1)`), server media role = none.
3. In SFU mode at N=4, read the SFU cost summary (FR-070): confirm
   local SFU transport count = **1** per participant (DD-002 = A;
   NOT `N−1`), uplink copies per published track = 1, outgoing
   senders = 2 per fully-publishing participant (audio + video),
   subscribed remote participant count = `N−1`, downstream
   forwarding deliveries per published track = `N−1`, downstream
   forwarding deliveries from this participant =
   activePublishedTrackCount × `N−1`, server media role = forwarding
   (SFU).
4. Open the SFU learning panel (FR-074): confirm a cross-mode
   summary table or equivalent surface compares mesh and SFU at
   N=4 across the dimensions of L24.

**Acceptance Scenarios**:

1. **Given** the stack is running, **When** the learner navigates
   between `/`, `/mesh/demo`, and `/sfu/demo`, **Then** each route
   loads its own mode UI and the mode badge unambiguously
   identifies which mode is active (FR-004); no route silently
   redirects to another mode.
2. **Given** four participants are in `/mesh/demo`, **When** the
   learner reads any participant's mesh cost summary, **Then** the
   summary shows local PC count = 3, room peer-pairs = 6,
   outgoing senders = 6, and server media role = "signaling only,
   no media" (002 FR-070; reachable here as a regression check).
3. **Given** four participants are in `/sfu/demo`, **When** the
   learner reads any participant's SFU cost summary, **Then** the
   summary shows local SFU transport count (the constant chosen
   by DD-002), uplink copies per published track = 1, downstream
   forwarded streams from this participant = 3, and server media
   role = "forwarding (SFU)"; this set of fields is visibly
   different from the mesh summary in step 2 (SC-S02).
4. **Given** the learner is viewing the SFU learning panel,
   **When** the learner reads the cross-mode comparison surface
   (FR-074), **Then** at minimum the following dimensions are
   compared at N=4: local PC count, outgoing sender count,
   uplink copies per published track, room peer-pair count,
   server media role, and media path; each cell unambiguously
   distinguishes mesh from SFU (L24).
5. **Given** SFU mode is in use, **When** the learner navigates
   back to `/` (1:1 mode) or `/mesh/demo` (mesh mode), **Then**
   both modes pass their existing 001 and 002 quickstart
   regressions (SC-S06, NFR-005); SFU mode has not silently
   altered 001 or 002 behavior or routes.

---

### User Story 3 — Observe browser↔SFU signaling lifecycle (Priority: P1)

A learner watches a browser join `/sfu/demo` and observes, in the
on-screen lifecycle indicators and event log, the offer/answer
exchange, ICE candidate exchange, ICE gathering progress,
RTCPeerConnection state transitions, and track lifecycle that take
place between the browser and the SFU. The learner does not need to
open browser devtools or read raw SDP/ICE strings to follow the
lifecycle.

**Why this priority**: Lifecycle visibility is the project-wide
Principle V mandate (Constitution v2.0.0). For SFU mode this is also
the only way a learner can observe L21 (the SFU is a WebRTC
participant from the browser's perspective): the same four lifecycle
states that exist in 001/002 must now exist on browser↔SFU transports.

**Independent Test**:
1. Open `/sfu/demo`, grant camera/mic, and watch the per-local-SFU-
   transport lifecycle indicators (FR-064): confirm the
   `signalingState` progresses through `have-local-offer` /
   `stable` (or equivalent for the chosen DD-002 topology), the
   `iceGatheringState` progresses through `gathering` → `complete`,
   the `iceConnectionState` progresses through `checking` →
   `connected`, and the `connectionState` progresses through
   `connecting` → `connected`.
2. Read the event log and confirm entries identify the SFU as the
   negotiation counterpart on every "offer created", "answer
   received", "ICE candidate sent/received", "connection state
   changed", "ICE state changed", "ICE gathering state changed",
   and "signaling state changed" entry (FR-061).
3. Open the learning inspector (FR-072) and confirm it summarizes
   SDP media sections (e.g. "1 audio m-line, 1 video m-line"),
   ICE candidate types observed (host / srflx / relay), STUN/TURN
   configuration, and whether any `relay` candidates appear; the
   inspector does NOT require the learner to read raw SDP/ICE
   strings (FR-072).

**Acceptance Scenarios**:

1. **Given** Alice has just opened `/sfu/demo` and granted media,
   **When** Alice's browser establishes its local SFU transport,
   **Then** Alice's UI shows transitions on each of the four
   Principle V lifecycle states (`signalingState`,
   `iceGatheringState`, `iceConnectionState`, `connectionState`)
   for that transport (FR-064), and the corresponding state-change
   events appear in the event log (FR-061).
2. **Given** Alice's local SFU transport is `connected`, **When**
   Bob joins `/sfu/demo`, **Then** Alice observes new track
   lifecycle events ("remote subscription added", "remote track
   received") scoped to Bob without Alice's local SFU transport
   regressing (FR-061, FR-062).
3. **Given** Alice opens the learning inspector, **When** Alice
   reads the SDP-section summary, ICE-candidate-type summary, and
   STUN/TURN configuration summary, **Then** all four pieces of
   information are present and labeled in plain language; raw SDP
   text is not required to understand the lifecycle (FR-072).
4. **Given** Alice's local SFU transport is `connected`, **When**
   the underlying network briefly fails and recovers, **Then**
   Alice's lifecycle indicators reflect the transition into
   `disconnected` / `failed` and back to `connected` (or the
   eventual stable state), and the event log records each
   transition with explicit SFU scope (FR-061, FR-080).

---

### User Story 4 — Observe publisher/subscriber media flow (Priority: P1)

A learner can distinguish, in the running app, **published local
tracks** (what this participant is sending up to the SFU) from
**subscribed remote tracks** (what this participant is receiving
from the SFU on behalf of other participants). The SFU learning
panel explicitly states that remote media is forwarded by the SFU,
not received directly from other browsers.

**Why this priority**: The publisher/subscriber model (L22) and
the SFU media-path label (L19, L23) are the two SFU-specific
mental models that distinguish SFU from mesh. If a learner cannot
distinguish "I published" from "I subscribed", they will model SFU
as just "mesh with a server in the middle" and miss the topology
shift entirely.

**Independent Test**:
1. Open `/sfu/demo` in two browsers, A and B; grant media in both.
2. In browser A, confirm the UI shows **published local tracks**
   (e.g. "Local: 1 audio publication, 1 video publication") and
   **subscribed remote tracks** (e.g. "Remote (B): 1 audio
   subscription, 1 video subscription") as distinct labeled
   surfaces (FR-040, FR-041, FR-051).
3. Open the SFU learning panel and confirm the panel explicitly
   states that remote media is forwarded by the SFU (FR-074,
   L23).
4. Inspect the event log and confirm "media publish started"
   events are scoped to the local publisher and "remote
   subscription added" / "remote track received" events are
   scoped to the remote participant being subscribed to (FR-061,
   FR-062).

**Acceptance Scenarios**:

1. **Given** Alice has joined `/sfu/demo` and published media,
   **When** Alice reads the local UI, **Then** her published
   local tracks (audio and video, plus any DD-004 screen share
   if included) are listed under a "Published" surface distinct
   from any "Subscribed" surface (FR-040, FR-041).
2. **Given** Alice and Bob are in `/sfu/demo`, **When** Bob's
   media is forwarded to Alice by the SFU, **Then** Alice's UI
   shows Bob's tracks under a per-remote "Subscribed (Bob)"
   surface, distinct from Alice's own "Published" surface
   (FR-051).
3. **Given** Alice opens the SFU learning panel, **When** Alice
   reads the panel's media-path explanation, **Then** the panel
   plainly states that "remote video and audio in this room are
   forwarded by the SFU; they are not received directly from
   other browsers" (FR-074, L19, L23).
4. **Given** the event log is open during step 1, **When** the
   learner scrolls back through the join sequence, **Then** the
   log distinguishes "media publish started" (scoped to the
   local publisher) from "remote subscription added" / "remote
   track received" (scoped to the remote participant being
   subscribed to) on every entry (FR-061, FR-062).

---

### User Story 5 — Media controls in SFU mode (Priority: P2)

A participant in SFU mode can mute and unmute the microphone, and
turn the camera off and on, during an SFU call. Local UI updates
immediately. Remote tiles update via **v3 participant- / track-level
media-state metadata** (FR-033, FR-090 (a)) which the SFU forwards
to other participants. Muting MUST NOT require renegotiation of the
browser↔SFU transport. Camera off/on changes are visible to remote
participants within 2 seconds.

**Why this priority**: Mute and camera-toggle are minimum sane
controls in any conferencing-shaped UI. They also exercise the
publisher/subscriber model (L22): media-state is participant- /
track-level metadata that the SFU fans out, distinct from the
browser↔SFU transport-negotiation messages which carry the
transport-attempt identifier (FR-090 (a)).

**Independent Test**:
1. Open `/sfu/demo` in two browsers, A and B; grant media in both.
2. In A, click "mute mic" and confirm A's local UI updates
   immediately (mic indicator off) and B's remote tile for A
   updates within 2 seconds to show A is muted (FR-033, FR-061).
3. In A, click "camera off" and confirm A's local preview updates
   immediately (camera-off indicator) and B's remote tile for A
   reflects the camera-off state within 2 seconds (FR-033,
   FR-061).
4. Confirm in the event log that mute/unmute and camera on/off
   produce "media state changed" entries scoped to the affected
   local participant (FR-061).
5. Confirm in the per-local-SFU-transport lifecycle indicators
   that no `signalingState` transition (i.e. no renegotiation)
   is required for mute/unmute (FR-033).

**Acceptance Scenarios**:

1. **Given** Alice is publishing audio and video to the SFU,
   **When** Alice mutes her microphone, **Then** Alice's local
   mic indicator updates immediately, Bob's remote tile for
   Alice indicates Alice is muted within 2 seconds, and no
   browser↔SFU renegotiation is required (FR-033).
2. **Given** Alice is publishing audio and video to the SFU,
   **When** Alice turns her camera off, **Then** Alice's local
   preview shows a camera-off placeholder immediately, Bob's
   remote tile for Alice reflects the camera-off state within
   2 seconds, and the change is observable in the event log
   (FR-033, FR-061).
3. **Given** Alice has muted and turned off her camera, **When**
   Alice unmutes and turns the camera back on, **Then** the
   reverse transitions occur with the same latency budgets and
   are visible in the event log.

---

### User Story 6 — Screen sharing in SFU mode (Priority: P2)

A participant can replace their outgoing video slot with screen
content via `RTCRtpSender.replaceTrack` on the existing video
sender (DD-004 = A); the SFU forwards screen content to other
participants exactly as it forwards camera content; the sender
count and topology summary make clear this is SFU-forwarded, not
mesh fan-out. Multiple participants MAY screen-share concurrently;
the application MUST NOT enforce a room-level single-sharer mutex.

**Why this priority**: Screen share is observable in 002 mesh
mode (002 US5) and is a natural learner expectation in any video
mode. Confirming the SFU forwards it (with the uplink still equal
to 1 copy per published track) rather than the participant fanning
it out `N − 1` times reinforces L20 and L23.

**Independent Test**:
1. Open `/sfu/demo` in two browsers, A and B; grant camera/mic.
2. In A, start screen share; confirm A's outgoing video sender
   has its track replaced with the screen track (no new
   transceiver added, no `signalingState` renegotiation
   required for the source swap), and the SFU cost summary
   shows uplink copies per published track still = 1 (FR-070,
   L20, FR-042).
3. Confirm B sees A's screen content in A's tile within 5
   seconds (FR-046).
4. Stop screen share via app or browser-native control;
   confirm A's published video reverts to camera or
   camera-off and B sees the change within 5 seconds.
5. Confirm the cost summary "outgoing senders" count and
   topology summary do NOT show mesh-style fan-out behavior
   (no `N − 1` outgoing copies of the screen).

**Acceptance Scenarios**:

1. **Given** Alice has joined `/sfu/demo` and granted
   camera/mic, **When** Alice starts screen share, **Then**
   Alice's published video sender's track is replaced with the
   screen track (no new sender added), the SFU uplink for that
   publication remains 1 copy (L20, FR-042, FR-070), and Bob
   sees Alice's screen via the SFU within 5 seconds.
2. **Given** screen share is active for Alice, **When** Alice
   stops screen share, **Then** Alice's published video sender
   reverts to camera (or camera-off, depending on Alice's
   prior camera state) and Bob sees the change within 5
   seconds.
3. **Given** Alice and Bob both have screen share active,
   **When** the learner reads the cost summary on any
   participant, **Then** both screen publications are
   forwarded by the SFU to all subscribers without any
   mesh-style fan-out semantics appearing in the cost summary
   (L20, FR-070); each sharer's uplink remains 1 copy of the
   screen track.
4. **Given** Alice has screen share active, **When** Alice
   reads the local "Published" surface (FR-040), **Then** the
   video publication is labeled as "screen" (not "camera"),
   and the source can be reverted via the same control without
   leaving the room (EC-012).

---

### User Story 7 — SFU failure visibility (Priority: P2)

A learner can distinguish, in the UI and event log, between
five different failure modes in SFU mode:
(i) a peer voluntarily leaving the room,
(ii) a single participant's browser↔SFU transport failing,
(iii) a single published track failing,
(iv) a single subscribed remote track failing, and
(v) the SFU media component itself becoming unavailable for the
whole room.

The UI MUST distinguish these from each other and MUST NOT
mislabel any of them as mesh-style "peer-pair failed" (which has
no meaning in SFU mode).

**Why this priority**: L25 (SFU failure domains) is the single
hardest mental shift from mesh. If failures are presented as
"peer-pair failed" the learner will believe SFU still has mesh
peer-pair semantics; this user story makes the failure-domain
shift directly observable.

**Independent Test**:
1. With four participants in `/sfu/demo`, have one participant
   close their tab; confirm the remaining three see the gone
   participant's tile and subscriptions removed within 10
   seconds, and the event log records a "participant left"
   entry scoped to the gone participant (FR-082, SC-S04).
2. Force-block one participant's browser↔SFU media transport
   (e.g., by blocking the relevant ICE/DTLS path) and confirm
   only that participant's local SFU transport indicator goes
   to `failed`; other participants' local SFU transports are
   unaffected (FR-080, L25).
3. Stop a single subscribed remote track (e.g., remote
   participant turns off the publishing source); confirm the
   affected remote tile shows a track-failure / track-ended
   indicator distinct from a transport failure (FR-082).
4. Simulate **mediafabric impairment with the
   signaling/control plane on `/ws/sfu` still alive** (e.g.,
   trigger an in-process forwarding-fault path that lets the
   server still broadcast on `/ws/sfu`); confirm all
   participants in the room see a clear server-reported
   "SFU unavailable" indicator distinct from any
   per-participant SFUTransport-failed indicator
   (FR-083 (a), US7 AS#4).
5. Separately, **stop the whole signaling process / container**
   (e.g., `docker compose stop signaling`, which under
   DD-001 = A takes down the in-process mediafabric and
   `/ws/sfu` together); confirm each client surfaces a local
   `signaling-error` within 5 seconds (FR-083 (b), SC-S04b,
   EC-005 (b), EC-010), labeled differently in the UI from
   the server-reported case in step 4.
6. Confirm at no point does the UI label any of the above as
   a mesh-style "peer-pair failed" indicator (FR-046, NFR-005).

**Acceptance Scenarios**:

1. **Given** four participants are in `/sfu/demo`, **When** one
   participant closes their tab or leaves the room, **Then**
   within 10 seconds the remaining participants' UI removes
   only that participant's tile and subscriptions; the event
   log records a "participant left" entry with that
   participant's scope (FR-082, SC-S04); other participants'
   media continues uninterrupted.
2. **Given** four participants are in `/sfu/demo`, **When**
   one participant's browser↔SFU media transport fails (and
   only that transport), **Then** that participant's local
   SFU transport indicator shows `failed` (FR-064, FR-080);
   other participants' local SFU transports remain
   `connected`; the affected participant is marked as
   transport-failed in the other participants' rosters,
   distinct from "left".
3. **Given** Bob is publishing audio and video to the SFU,
   **When** Bob's published video track ends (e.g. camera
   unplugged) without his transport failing, **Then** Alice's
   remote tile for Bob shows a track-ended indicator on the
   video track only; Alice's remote audio subscription for
   Bob continues; Bob's transport indicator remains
   `connected` (FR-082).
4. **Given** four participants are in `/sfu/demo`, **When**
   the SFU forwarding fabric is impaired but the
   signaling/control plane on `/ws/sfu` remains responsive,
   **Then** all four participants receive the
   server-broadcast "SFU unavailable" status and the UI
   shows a room-level "SFU unavailable" indicator distinct
   from any per-participant SFUTransport failure
   (FR-083 (a), L25); the UI does NOT silently present the
   SFU as a peer that left. **And** when instead the entire
   signaling/control process is down (FR-083 (b)), each
   client surfaces a local `signaling-error` within 5
   seconds (SC-S04b, EC-005 (b), EC-010), labeled
   differently in the UI from case (a).
5. **Given** any of the above failures, **When** the learner
   reads the event log, **Then** every failure entry is
   scoped to the correct domain: `local`, `remote
   participant`, `SFU`, `publisher`, `subscriber`, `media
   track`, `signaling`, or `media path` (FR-061); no failure
   entry uses mesh-style "peer-pair failed" wording in SFU
   mode.

---

### Edge Cases

- **EC-001 — Camera/microphone permission denied**. If the
  participant fails to acquire camera and microphone (denial,
  device unavailable, or any other `getUserMedia` failure) the
  participant transitions to `released` ParticipantPresence,
  the participant's room slot is freed, no browser↔SFU
  transport is established, and a structured permission-denied
  result is surfaced. The MVP does NOT support a subscribe-only
  observer mode (Non-Goals). The learner MAY retry from the SFU
  route by reloading or re-joining once permissions are granted.
  (See FR-031, FR-080, Non-Goals.)
- **EC-002 — Permission revoked mid-session**. If media
  permissions are revoked while the participant is publishing,
  the participant's published tracks transition to a
  released/ended state, the SFU stops forwarding those tracks
  to subscribers, and remote tiles for this participant show
  the affected tracks ending. The browser↔SFU transport itself
  remains up if other tracks are still published. (See FR-031,
  FR-082.)
- **EC-003 — 5th participant attempts to join a full room**.
  The 5th browser receives a structured room-full result; no
  SFU transport is established for the 5th browser; the
  existing four-person room is unaffected (FR-011, US1 AS#4).
- **EC-004 — Browser tab close**. A participant closing the tab
  triggers ungraceful disconnect; remaining participants see
  the gone participant's tile and subscriptions removed within
  10 seconds (SC-S04). Cleanup completes server-side without
  leaking SFU resources for the gone participant (FR-082,
  FR-091).
- **EC-005 — SFU media component impaired or down**. Two
  sub-cases (DD-001 = A means the media-plane and
  signaling-plane share the same process; failure mode
  determines which sub-case applies):
  (a) **Forwarding impaired, signaling alive** — the
  signaling/control plane on `/ws/sfu` is still
  responsive and broadcasts an "SFU unavailable" status
  (FR-083 (a)); all participants see the room-level
  "SFU unavailable" indicator.
  (b) **Whole process down** — `/ws/sfu` itself is lost;
  no server-reported event reaches the clients; each
  client surfaces a local `signaling-error` within 5
  seconds (FR-083 (b), SC-S04b). Already-established
  browser↔SFU media MAY continue carrying media until it
  fails on its own (EC-010).
  In neither sub-case does the MVP auto-recover;
  participants MUST leave/rejoin the room (Non-Goals,
  NFR-010).
- **EC-006 — Single subscribed remote track ends**. If a remote
  participant's video source ends (e.g. camera unplugged) but
  audio continues, the affected remote tile shows the video as
  ended without affecting the audio subscription or the local
  SFU transport state (FR-082).
- **EC-007 — Mute/unmute does not renegotiate**. Mute/unmute
  MUST NOT trigger any `signalingState` transition (i.e. no
  re-offer/re-answer). The local UI updates immediately
  (FR-033, US5 AS#1).
- **EC-008 — Network blip on a single participant**. A short
  network failure on one participant's browser↔SFU transport
  causes that participant's lifecycle indicators to transition
  through `disconnected` / `failed` and back to the eventual
  stable state; other participants' local SFU transports are
  unaffected (FR-080, US7 AS#2).
- **EC-009 — Late ICE candidate or stale negotiation message**.
  Browser↔SFU negotiation messages carry an attempt identifier
  (FR-090); messages that do not match the current attempt
  identifier for the local SFU transport MUST be discarded
  before being applied. (See FR-090, FR-026.)
- **EC-010 — Local signaling-loss**. If the local browser loses
  the `/ws/sfu` signaling connection, a `signaling-error` is
  surfaced to the local participant within 5 seconds (SC-S04b);
  already-established media MAY continue carrying media until
  it fails on its own. The MVP does NOT auto-reconnect
  signaling. (See Non-Goals, NFR-010.)
- **EC-011 — Remote participant leaves while local participant
  is mid-publish**. If a remote participant leaves while the
  local participant is in the middle of starting a new
  publication (e.g. screen share), the local publish completes
  to the SFU and the SFU stops forwarding to the gone
  participant; no error is raised on the publishing
  participant. (See FR-082.)
- **EC-012 — Media-source change does not require room
  rejoin**. Switching publication sources (camera on/off,
  mute/unmute, and any DD-004 screen share) MUST be possible
  without leaving and rejoining the room. (See FR-033, US5,
  US6.)
- **EC-013 — Invalid room ID**. A request to a route whose
  `roomId` does not satisfy the room-ID validation rule
  (trimmed, case-sensitive, 1–64 characters,
  `[A-Za-z0-9._-]`) MUST be rejected by both client and
  server before any browser↔SFU media transport is
  established. (See FR-010.)
- **EC-014 — Concurrent join racing capacity**. If two
  participants attempt to become the 5th and 6th member of a
  4-capacity room simultaneously, both MUST receive
  structured room-full results; the existing four-person
  room MUST remain stable; no transient capacity-of-5 state
  is observable. (See FR-011.)
- **EC-015 — Chat omitted in SFU MVP**. Per DD-003 = A
  (resolved 2026-05-03), the SFU UI MUST NOT display a chat
  panel and the SFU event log MUST NOT include chat-related
  entries. The v3 signaling contract MUST NOT carry chat
  message types. The 001 pairwise DataChannel chat and 002
  mesh DataChannel chat remain reachable via their own routes.
  (See FR-002, FR-003, FR-062, FR-090, Non-Goals.)
- **EC-016 — Inspector MUST NOT render raw payloads**. Per
  DD-005 = B (resolved 2026-05-03), the learning inspector
  surfaces derived forwarding-delivery / track summaries
  (FR-072 (iv), (v)) but MUST NOT render raw RTP packets,
  raw SDP strings, raw ICE candidate strings, raw SSRC hex
  values, or TURN credentials in the UI, event log, or
  application logs. The v3 contract MAY transmit raw SDP
  offer/answer and raw ICE candidate payloads on the wire
  (FR-090) because they are required for WebRTC
  negotiation; the prohibition is on rendering and logging
  those payloads, not on transmitting them as signaling
  payloads. The v3 contract MUST NOT carry raw RTP
  payloads or TURN credentials at all. Any future
  debug-only "raw view" of SDP/ICE in the UI is explicitly
  out of scope. (See FR-072, FR-090, NFR-004, Non-Goals.)

## Requirements *(mandatory)*

### Functional Requirements

#### Mode coexistence

- **FR-001**: The 001 1:1 mode MUST continue to be reachable at the
  route `/` and on the signaling endpoint `/ws` with no behavioral
  change introduced by 003.
- **FR-002**: The 002 mesh mode MUST continue to be reachable at
  the route `/mesh/:roomId` and on the signaling endpoint
  `/ws/mesh` with no behavioral change introduced by 003.
- **FR-003**: SFU mode MUST be implemented in a separate codepath
  from 001 and 002. The frontend SFU code MUST live in
  `frontend/src/modes/sfu/` and the backend SFU code MUST live in
  `signaling/internal/modes/sfu/`. Cross-mode imports between SFU
  and the other two modes are forbidden and MUST be enforced by
  `scripts/audit-boundaries.sh` (extended in plan/implementation
  to recognize the `sfu` mode).
- **FR-004**: The application MUST display a clear, persistent,
  always-visible UI indicator (mode badge or equivalent) that
  identifies which mode (1:1 / mesh / SFU) is currently active.
  The SFU badge MUST be visually distinguishable from the 1:1 and
  mesh badges at a glance and MUST identify the SFU capacity (4
  participants).

#### SFU room admission and presence

- **FR-010**: SFU room IDs MUST be trimmed before validation,
  case-sensitive, 1–64 characters, and may contain only printable
  ASCII letters, digits, hyphen, underscore, or dot
  (`[A-Za-z0-9._-]`). Both client and server MUST reject IDs that
  do not match this rule before any browser↔SFU media transport
  is established. (See EC-013.)
- **FR-011**: An SFU room MUST admit at most **4** participants.
  Any participant attempting to join a full SFU room MUST receive
  a structured room-full result; the existing four-person room
  MUST remain unaffected by the rejected join attempt. (See
  EC-003, EC-014, US1 AS#4.)
- **FR-012**: On admission, the SFU signaling layer MUST deliver
  an initial roster snapshot to the joining participant naming
  the other participants currently in the room and their
  publisher/subscriber state. Subsequent presence and media-state
  changes MUST be broadcast on `/ws/sfu` to all participants in
  the room.
- **FR-013**: The SFU mode MUST keep the following four state
  surfaces **distinct** (no single enum mixes them; remote tiles
  render a composition of them, not a flattened union):
  1. **ParticipantPresence** (per Participant in the room):
     `joined`, `media-ready`, `released`, `left`.
  2. **SFUTransportState** (per local SFUTransport — exactly
     one per participant under DD-002 = A): `new`,
     `connecting`, `connected`, `disconnected`, `failed`,
     `closed`. Tracks the local browser↔SFU
     `RTCPeerConnection`'s composite condition; surfaces are
     the four Principle V lifecycle states (FR-022, FR-064).
  3. **PublisherState** (per local PublishedTrack):
     `not-publishing`, `publishing`, `muted`, `track-ended`,
     `failed`.
  4. **SubscriberState** (per remote Participant per
     SubscribedTrack): `not-subscribed`, `subscribing`,
     `subscribed`, `track-ended`, `failed`.
  Remote tiles MUST render the remote Participant's
  ParticipantPresence plus the local SubscriberState for that
  remote's tracks, plus per-track render state. Remote tiles
  MUST NOT treat the local browser↔SFU SFUTransportState as a
  per-remote-participant state.
- **FR-014**: When a participant leaves the SFU room, the
  signaling layer MUST broadcast the leave event so that other
  participants' UIs update within 10 seconds (SC-S04). Cleanup
  MUST tear down that participant's SFU transport state and
  forwarding entries server-side without leaking resources for
  the gone participant.

#### Browser↔SFU signaling and lifecycle

- **FR-020**: The SFU mode MUST establish exactly **one
  bidirectional `RTCPeerConnection` per participant** between the
  browser and the SFU (DD-002 = A, resolved 2026-05-03). Adding or
  removing a subscribed remote track on this PC MUST be handled via
  SDP renegotiation on the existing PC (a `signalingState`
  transition is expected and observable in FR-064 indicators); a
  fresh PC MUST NOT be created per subscriber. The cost summary
  (FR-070) and learning inspector (FR-072) MUST reflect this
  one-PC-per-participant topology.
- **FR-021**: SFU offer/answer exchange between browser and SFU
  MUST occur on `/ws/sfu` only; v1 messages MUST NOT appear on
  `/ws/sfu` and v3 messages MUST NOT appear on `/ws` or
  `/ws/mesh`.
- **FR-022**: The four Principle V lifecycle states —
  `signalingState`, `iceGatheringState`, `iceConnectionState`,
  `connectionState` — MUST be tracked on the browser side for the
  participant's single bidirectional SFU transport (DD-002 = A) and
  surfaced in the always-on lifecycle indicators (FR-064) and in the
  event log (FR-061). Renegotiations triggered by subscriber add /
  remove MUST appear as `signalingState` transitions on this single
  transport, not as new transports.
- **FR-023**: ICE candidate exchange between browser and SFU MUST
  flow over `/ws/sfu`; every ICE candidate sent or received MUST
  produce an event-log entry scoped to the local SFU transport
  (FR-061).
- **FR-024**: Track lifecycle on the browser side (added,
  ended, replaced) MUST produce event-log entries scoped to the
  local publisher (for outgoing tracks) or the remote subscriber
  (for incoming tracks) (FR-061, FR-062).
- **FR-025**: When a participant joins, becomes media-ready, or
  leaves, the SFU MUST update only the affected PublisherState /
  SubscriberState on each remaining participant. Existing
  `connectionState` and `iceConnectionState` indicators on the
  remaining participants' SFUTransports MUST NOT regress
  (e.g. `connected` MUST NOT flip to `connecting`) solely
  because of the roster change. **However**, under DD-002 = A
  the participant's single SFUTransport MAY enter expected
  `signalingState` transitions (e.g. `stable` →
  `have-local-offer` / `have-remote-offer` → `stable`) during
  the renegotiation that adds or removes the recvonly
  transceiver for the joining/leaving remote. Such transitions
  MUST be visible in the FR-064 indicators and the FR-061 event
  log; they are expected, not regressions (US1 AS#3, US3 AS#2).
- **FR-026**: A failed local SFU transport MUST be recoverable
  via leave-and-rejoin in the MVP. The MVP does NOT include
  automatic per-transport reconnect, automatic ICE restart, or
  automatic signaling reconnect; these are explicitly out of
  scope (Non-Goals, NFR-010).

#### Local media and media controls

- **FR-030**: SFU mode MUST acquire local media (camera +
  microphone) using the same browser primitives used by 001 and
  002 (no project-internal wrapper that hides browser APIs);
  see NFR-007.
- **FR-031**: If the participant fails to acquire camera and
  microphone (permission denied, device unavailable, or any
  other `getUserMedia` failure) the participant MUST transition
  to `released` ParticipantPresence (FR-013), the room slot
  MUST be freed, no browser↔SFU transport MUST be
  established, and a structured permission-denied result MUST
  be surfaced to the participant. The MVP does NOT support a
  subscribe-only observer mode; the participant cannot remain
  in the room without publishing media. The learner MAY retry
  by reloading or re-joining the SFU route once permissions
  are granted (EC-001, Non-Goals).
- **FR-032**: The SFU mode MUST surface local published tracks
  (audio, video, with the video sender's source switchable
  between camera and screen per DD-004 = A and FR-042) under a
  labeled "Published" surface in the local UI (FR-040). The
  video publication's current source (camera vs screen) MUST
  be labeled.
- **FR-033**: Mute/unmute and camera on/off controls MUST be
  available in SFU mode and MUST update the local UI
  immediately. Mute/unmute MUST NOT require renegotiation of
  the browser↔SFU transport. Remote-side reflection of these
  state changes MUST be sent as **v3 participant- /
  track-level media-state metadata** (FR-090 (a) explicitly
  classifies media-state as participant- or track-level, NOT
  transport-attempt-scoped); the SFU forwards the metadata
  to other participants and remote tiles MUST render the
  update within 2 seconds. The metadata MUST be scoped to
  the affected Participant and the affected PublishedTrack;
  it MUST NOT carry a transport-attempt identifier.
  Switching the outgoing video source between camera and
  screen (FR-042, DD-004 = A) follows the same media-state
  metadata path and likewise does NOT trigger renegotiation.

#### Publisher / subscriber state and media path

- **FR-040**: The SFU mode UI MUST distinguish, in the local
  UI, **published local tracks** (sent up to the SFU by this
  participant) from **subscribed remote tracks** (received
  from the SFU on behalf of other participants). The two
  surfaces MUST be separately labeled.
- **FR-041**: Each published local track MUST be represented
  by an explicit indicator. The MVP publishes exactly two
  tracks per fully-publishing participant: one audio
  publication and one video publication (DD-002 = A,
  DD-004 = A). The video publication's source MAY be camera
  or screen; switching between sources via
  `RTCRtpSender.replaceTrack` (FR-042) does NOT add a third
  publication and does NOT change the published-track count.
- **FR-042**: The local participant MUST upload **one copy
  per published track** to the SFU regardless of how many
  other participants subscribe to it. This property MUST be
  reflected in the cost summary (FR-070). Switching the
  outgoing video source between camera and screen (DD-004 = A)
  MUST use `RTCRtpSender.replaceTrack` on the existing video
  sender; it MUST NOT add a second video sender, MUST NOT
  add a new transceiver, and MUST NOT trigger renegotiation
  on the participant's single SFU transport (DD-002 = A).
  Multiple participants MAY screen-share concurrently; the
  application MUST NOT enforce a room-level single-sharer
  mutex.
- **FR-046**: The media path MUST be explicitly labeled as
  **browser ↔ SFU** on every remote tile, in the SFU
  learning panel (FR-074), and in the SFU cost summary
  (FR-070). The UI MUST NOT label any media flow as
  browser↔browser in SFU mode.

#### Remote media rendering

- **FR-051**: For each other participant in the room, the
  local UI MUST render a remote tile that displays the
  subscribed remote video track and plays the subscribed
  remote audio track. The tile MUST be labeled with the
  remote participant's identifier and MUST indicate that
  remote media is forwarded by the SFU (FR-046).
- **FR-052**: When a remote participant's video track ends
  (EC-006), the affected remote tile MUST show a track-ended
  indicator on the video without affecting the audio
  subscription or the local SFU transport state.

#### Event log and lifecycle visibility

- **FR-060**: The SFU mode UI MUST include an always-visible
  event log surface in the running app. The learner MUST NOT
  need to open browser devtools to read the event log.
- **FR-061**: Every event-log entry MUST identify its scope
  using one or more of the following: `local`, `remote
  participant` (by identifier), `SFU`, `publisher`,
  `subscriber`, `media track`, `signaling`, or `media path`.
  Pairwise events tied to a remote participant MUST carry
  that participant's identifier on the entry.
- **FR-062**: The SFU mode event log MUST support at minimum
  the following event types: `room joined`, `join rejected`,
  `local media acquired`, `media publish started`,
  `media publish stopped`, `remote subscription added`,
  `remote subscription removed`, `offer created`,
  `offer received`, `answer created`, `answer received`,
  `ICE candidate sent`, `ICE candidate received`,
  `connection state changed`, `ICE state changed`,
  `ICE gathering state changed`, `signaling state changed`,
  `local track published`, `remote track received`,
  `media state changed`, `SFU media forwarded`,
  `participant left`, `cleanup completed`, `error occurred`.
  The `SFU media forwarded` event type MUST be emitted at
  **forwarding-lifecycle or routing-summary granularity**,
  NOT per RTP packet (e.g. "Alice video forwarding
  established to Bob, Carol, Dan" or "Bob audio forwarding
  torn down"). Per-packet emission would overwhelm the
  learner and is explicitly out of scope; the cost summary
  (FR-070) and the inspector forwarding-delivery summary
  (FR-072 (iv)) carry the steady-state counts.
- **FR-063**: Event-log entries MUST be human-readable in
  plain language; the learner MUST NOT need to parse JSON
  or read raw SDP/ICE strings to follow the lifecycle
  (FR-072, NFR-004).
- **FR-064**: For the participant's single local SFU transport
  (DD-002 = A), the SFU mode UI MUST surface always-on lifecycle
  indicators for all four Principle V states: `signalingState`,
  `iceGatheringState`, `iceConnectionState`, `connectionState`.
  There is exactly one such row per participant (in contrast to
  002 mesh, which has `N − 1` per-peer-pair rows).
- **FR-065**: For each remote participant, the SFU mode UI
  MUST surface always-on indicators for: (i) that
  participant's ParticipantPresence (FR-013 surface 1);
  (ii) the local SubscriberState for each track subscribed
  from that remote (FR-013 surface 4); and (iii) per-track
  render state (active / track-ended / failed; FR-052,
  FR-082). The remote tile MUST NOT display the local
  SFUTransportState as if it were per-remote.

#### SFU topology / cost summary and learning inspector

- **FR-070**: The SFU mode UI MUST include a cost summary
  panel that displays at minimum:
  (a) local SFU transport count (= **1** per participant;
  DD-002 = A);
  (b) uplink copies per published track (= 1; FR-042);
  (c) outgoing senders count (= **2** per fully-publishing
  participant — one audio + one video; DD-004 = A keeps
  this constant when screen share is active because screen
  share replaces the video source rather than adding a
  sender);
  (d) subscribed remote participant count (= `N − 1`);
  (e) downstream forwarding deliveries per published track
  (= `N − 1`);
  (f) downstream forwarding deliveries from this participant
  (= activePublishedTrackCount × `N − 1`);
  (g) server media role (= "forwarding (SFU)");
  (h) participant count (= N);
  (i) room topology label "SFU (1 bidirectional PC per
  participant)".
  These counts are at the **logical forwarding-delivery
  level** (one delivery per (publishedTrack, subscriber)
  pair) and are independent of how the in-process
  `mediafabric` represents SSRCs internally; the spec does
  NOT require distinct outgoing SSRCs per subscriber
  (FR-072 (iv)).
- **FR-071**: The cost summary MUST be present and reachable
  from the main SFU room UI without opening any modal or
  navigating away from the route.
- **FR-072**: The SFU mode UI MUST include a learning
  inspector that surfaces the following plain-language
  summaries (DD-005 = B):
  (i) the SDP media-section count for the local SFU
  transport (e.g. "1 audio m-line, 1 video m-line");
  (ii) the ICE candidate types observed on the local SFU
  transport (host / srflx / relay) and whether any
  `relay` candidates appear;
  (iii) the configured STUN/TURN servers (server addresses
  only — TURN credentials MUST NOT be exposed, NFR-004);
  (iv) for each PublishedTrack of this Participant: a
  forwarding-delivery summary at the SFU, e.g. "1 inbound
  source observed at the SFU, forwarded to `N − 1`
  subscriber deliveries". The summary MAY include
  redacted or labeled SSRC identifiers if the
  `mediafabric` implementation can provide them safely,
  but the spec does NOT require distinct outgoing SSRCs
  per subscriber, and raw SSRC hex values MUST NOT be
  rendered;
  (v) for each SubscribedTrack: the originating remote
  Participant identifier, the track kind (audio / video),
  and the current source label (microphone / camera /
  screen, per DD-004).
  Raw SDP strings, raw ICE candidate strings, raw RTP
  payloads, and TURN credentials MUST NOT be rendered in
  the inspector (NFR-004); raw SDP and raw ICE candidates
  MAY traverse the v3 wire as signaling payloads required
  for negotiation (FR-090).
- **FR-074**: The SFU learning panel MUST explain, in plain
  language: (i) that the media path is browser↔SFU, not
  browser↔browser (L19); (ii) that the SFU forwards media
  packets between participants and does not record or
  persist them (L23); (iii) that local published tracks
  are uploaded once per track to the SFU and forwarded by
  the SFU as `N − 1` subscriber deliveries (L20, surfaced
  as the forwarding-delivery summary in FR-072 (iv) and
  the cost summary fields in FR-070 (e), (f)); (iv) a
  cross-mode comparison surface contrasting mesh and SFU
  at N=4 across the dimensions of L24; (v) the
  publisher/subscriber model with the per-PublishedTrack
  and per-SubscribedTrack summaries from FR-072 (iv) and
  (v) (L22).

#### Cleanup, leaving, and failure handling

- **FR-080**: SFU mode MUST surface a per-local-SFU-transport
  failure indicator distinct from a per-published-track
  failure indicator and distinct from a per-subscribed-track
  failure indicator. The vocabulary MUST NOT use mesh-style
  "peer-pair failed" wording in SFU mode (NFR-005).
- **FR-081**: A failure of a single published track MUST be
  surfaced on the local "Published" surface for the affected
  track only; other published tracks and the local SFU
  transport itself MUST remain unaffected.
- **FR-082**: A failure or end of a single subscribed remote
  track MUST be surfaced on the affected remote tile only;
  other subscribed remote tracks for the same remote
  participant MUST remain unaffected unless they end on their
  own (EC-006).
- **FR-083**: SFU-unavailable is reported via two distinct
  paths reflecting two distinct failure modes (DD-001 = A
  means the media-plane and signaling-plane share the same
  process, so the signaling plane MAY or MAY NOT survive a
  media-plane failure):
  (a) **Server-reported SFU-unavailable** — when the
  forwarding fabric is impaired but the signaling/control
  plane on `/ws/sfu` remains alive enough to broadcast the
  condition, the server MUST broadcast an
  "SFU unavailable" status on `/ws/sfu` and the SFU mode
  UI MUST display a clear room-level "SFU unavailable"
  indicator visually distinct from any per-participant
  SFUTransport-failed indicator. The UI MUST NOT present
  the SFU as a peer that left (US7 AS#4, L25).
  (b) **Local signaling-loss fallback** — when the entire
  signaling/control process is down (or the local browser's
  `/ws/sfu` connection is lost for any other reason), the
  client cannot receive a server-reported SFU-unavailable
  event and MUST instead surface a local `signaling-error`
  within 5 seconds (SC-S04b, EC-010). This is distinct from
  case (a) and MUST be labeled differently in the UI so the
  learner can tell "the SFU told us it lost media routing"
  apart from "we lost contact with the SFU control plane".
- **FR-084**: When a participant leaves, cleanup MUST
  complete in both the browser (local SFU transport
  released) and the SFU (forwarding entries removed) and
  MUST be observable in the event log via `participant
  left` and `cleanup completed` entries (FR-062).

#### Signaling contract v3 and server media role

- **FR-090**: SFU signaling MUST use a new **v3 contract**
  scoped to the `/ws/sfu` endpoint.
  (a) **Transport-attempt scope.** The v3 contract MUST
  carry a transport-attempt identifier (analogous to 002's
  pair-attempt identifier per peer-pair) ONLY on
  browser↔SFU **transport-negotiation** messages — offer,
  answer, ICE candidate, and any explicit transport
  reconnect / renegotiation message — scoped to the
  participant's single SFU transport (DD-002 = A) so that
  stale negotiation messages can be discarded before being
  applied (EC-009). Media-state messages (mute, camera
  on/off, video-source switch between camera and screen)
  are participant-level or track-level metadata, NOT
  transport-negotiation events; they MUST carry the
  relevant Participant / PublishedTrack / SubscribedTrack
  identifier and MUST NOT be treated as
  transport-attempt-scoped messages (FR-033).
  (b) **Inspector summaries.** The v3 contract MUST carry
  the SFU-computed inspector summaries required by
  FR-072 (iv) and (v) — per-PublishedTrack
  forwarding-delivery counts and per-SubscribedTrack
  origin / kind / source labels (DD-005 = B).
  (c) **WebRTC negotiation payloads.** The v3 contract
  MAY carry raw SDP offer/answer payloads and raw ICE
  candidate payloads as required to establish the
  browser↔SFU WebRTC transport — these are signaling
  payloads necessary for WebRTC negotiation and have no
  alternative wire form.
  (d) **Forbidden on wire.** The v3 contract MUST NOT
  carry raw RTP payloads, media payloads, TURN
  credentials, or chat message types (DD-003 = A,
  NFR-004, EC-015, EC-016).
  (e) **Endpoint isolation.** v1 messages MUST NOT appear
  on `/ws/sfu` and v3 messages MUST NOT appear on `/ws`
  or `/ws/mesh`.
- **FR-091**: The SFU media component MUST be implemented
  as an in-process Go package under
  `signaling/internal/modes/sfu/mediafabric/` (DD-001 = A,
  resolved 2026-05-03). It MUST be reachable from the SFU
  mode codepath only and MUST NOT be importable from the
  001 or 002 codepaths. The 001 and 002 server code paths
  MUST NOT receive or forward media (NFR-005, NFR-008,
  §Constitutional alignment).

### Non-Functional Requirements

- **NFR-001 — Secure context**: SFU mode MUST follow the same
  secure-context rules as 001 and 002 (HTTPS or `localhost`
  in browser; no mixed-content downgrades).
- **NFR-002 — No hardcoded secrets**: No TURN credentials,
  STUN auth tokens, or other secrets MUST be hardcoded in
  the frontend or backend SFU sources. Local Docker Compose
  development MUST work without secrets being committed to
  the repository.
- **NFR-003 — Honest security and media-path claims
  (Principle VII)**: The SFU mode UI, learning panel, and
  documentation MUST truthfully state that media flows
  browser↔SFU (not browser↔browser) and that SFU media is
  NOT end-to-end encrypted in MVP — the SFU media component
  has access to media for forwarding. The MVP MUST NOT
  claim E2EE on SFU media.
- **NFR-004 — No raw SDP / ICE / TURN credential / media
  payload rendering or logging**: The SFU mode UI, event
  log, learning inspector, and any application logs MUST
  NOT surface or render raw SDP strings, raw ICE candidate
  strings (beyond high-level type categorization in the
  inspector), TURN credentials, raw RTP payloads, or media
  payloads. The learning inspector MAY surface derived
  summaries (m-line count, candidate type breakdown, SDP
  section labels, forwarding-delivery counts per FR-072)
  only. Note: the v3 signaling contract MAY carry raw SDP
  offer/answer and raw ICE candidate payloads on the wire
  as required for browser↔SFU WebRTC negotiation
  (FR-090); this NFR governs **rendering and logging** of
  those payloads, not their transmission as signaling
  payloads.
- **NFR-005 — SFU mode must not alter 001 or 002 behavior**:
  No source change introduced by 003 MAY alter observable
  behavior of 001 (`/`, `/ws`, v1 contract) or 002
  (`/mesh/:roomId`, `/ws/mesh`, v2 contract). The 001 and
  002 quickstart regressions MUST pass after 003 ships
  (SC-S06).
- **NFR-006 — Mode boundary audit and ring audit**:
  `scripts/audit-boundaries.sh` MUST be extended (in
  plan/implementation) to recognize the `sfu` mode and
  enforce that SFU code does NOT import 1:1 or mesh
  modules and that 1:1, mesh, and shared modules do NOT
  import SFU. The frontend ring audit and backend ring
  audit MUST pass for SFU code on the same terms as 001
  and 002.
- **NFR-007 — No WebRTC wrapper hiding browser-side
  primitives**: The SFU frontend MUST use
  `RTCPeerConnection`, `getUserMedia`, `getDisplayMedia`,
  `RTCRtpSender`, and `RTCRtpReceiver` directly (or via a
  thin, transparent helper that does NOT obscure the
  browser primitives from a learner reading the source).
- **NFR-008 — Server-side media component isolated to SFU
  mode**: The SFU media component, implemented in-process
  under `signaling/internal/modes/sfu/mediafabric/` per
  DD-001 (Option A), MUST NOT be importable, callable, or
  otherwise reachable from the 001 or 002 codepaths. The
  extended `scripts/audit-boundaries.sh` (NFR-006) MUST
  enforce this isolation by package boundary.
- **NFR-009 — Learning indicators only**: The SFU cost
  summary, learning inspector, lifecycle indicators, and
  event log are learning indicators only — NOT alerting,
  aggregation, or longitudinal-analysis signals. The MVP
  MUST NOT emit metrics to external monitoring systems.
- **NFR-010 — Simplicity boundaries (no SFU feature
  creep)**: SFU MVP MUST NOT include simulcast/SVC, codec
  selection UI, recording, Insertable Streams E2EE,
  production TURN automation, autoscaling SFU cluster,
  multi-room distributed state, production monitoring
  stack, mobile native apps, file transfer, global chat
  ordering, or production security claims beyond what is
  actually implemented (Non-Goals, §Constitutional
  alignment).

### Key Entities

- **SFURoom**: An SFU-mode room identified by a route
  parameter (`/sfu/:roomId`) and a corresponding signaling
  context on `/ws/sfu`. Has an immutable capacity of **4**
  participants. Tracks the set of admitted Participants,
  their publisher/subscriber state, and the room's view of
  the SFU media component's availability. An SFURoom is
  distinct from the 001 1:1 Room (capacity 2, peer-to-peer)
  and the 002 Mesh Room (capacity 4, peer-to-peer) and
  MUST NOT share state with either.
- **Participant**: A single browser session admitted to an
  SFURoom. Has an identifier and four distinct state
  surfaces (FR-013): a **ParticipantPresence**
  (`joined` / `media-ready` / `released` / `left`); a
  **SFUTransportState** for the participant's single
  bidirectional SFUTransport (DD-002 = A); a
  **PublisherState** per PublishedTrack; and one
  **SubscriberState** per SubscribedTrack per remote
  Participant. The MVP requires camera + microphone
  publication; subscribe-only observer mode is NOT
  supported (FR-031, EC-001, Non-Goals).
- **Publisher**: The Participant's outgoing role: the set
  of PublishedTracks the Participant has sent up to the
  SFU, carried as sendonly transceivers on the
  Participant's single bidirectional SFU transport
  (DD-002 = A), with per-track media-state (publishing /
  muted / track-ended / failed).
- **Subscriber**: The Participant's incoming role: the
  set of SubscribedTracks the Participant has subscribed
  to via the SFU (one set per remote Participant), carried
  as recvonly transceivers added to the Participant's
  single bidirectional SFU transport (DD-002 = A), with
  per-track render state (subscribed / muted / track-ended
  / failed). Adding or removing a recvonly transceiver
  triggers an SDP renegotiation on the single SFU
  transport.
- **PublishedTrack**: A single outgoing media track that
  this Participant uploads to the SFU. Per DD-004 = A and
  FR-041, a fully-publishing Participant has exactly two
  PublishedTracks: one audio publication and one video
  publication. The video publication's source is camera or
  screen; switching source via `RTCRtpSender.replaceTrack`
  (FR-042) does NOT add a third PublishedTrack. Has a kind
  (audio / video), a current source label (microphone /
  camera / screen), a media-state, and an identifier the SFU
  uses for routing.
- **SubscribedTrack**: A single incoming media track that
  this Participant receives from the SFU on behalf of a
  remote Participant. Has a kind (audio / video), a current
  source label (microphone / camera / screen — the latter
  reflecting the remote Participant's outgoing video source
  per DD-004 = A), a render-state, and an identifier the SFU
  uses to route the corresponding PublishedTrack.
- **SFUTransport**: The browser↔SFU `RTCPeerConnection`
  instance held by a Participant. Per DD-002 = A, there
  is **exactly one SFUTransport per Participant**, and it
  is bidirectional (carries both publish sendonly
  transceivers and subscribe recvonly transceivers).
  Has its own **SFUTransportState** (FR-013 surface 2:
  `new` / `connecting` / `connected` / `disconnected` /
  `failed` / `closed`) plus the four Principle V
  lifecycle indicators (`signalingState`,
  `iceGatheringState`, `iceConnectionState`,
  `connectionState`) surfaced per FR-064. Is the unit of
  "transport failure" in L25 (FR-080).
- **SFUMediaComponent**: The server-side WebRTC endpoint
  that receives PublishedTracks from Participants and
  forwards them as SubscribedTracks to other
  Participants. Implemented as an in-process Go
  `mediafabric` package under
  `signaling/internal/modes/sfu/mediafabric/` (DD-001 = A,
  FR-091, NFR-008). Reachable only from the SFU mode
  codepath. Is NOT a Participant in the room sense.
  Because DD-001 = A places the media-plane and the
  signaling/control plane in the same process, "SFU
  unavailable" can be reported on `/ws/sfu` by the server
  ONLY when the signaling/control plane remains alive
  enough to publish that status (FR-083 (a)). If the whole
  process is down, no server-broadcast is possible and
  clients surface a local `signaling-error` instead
  (FR-083 (b), EC-005, EC-010, SC-S04b).
- **SignalingMessageV3**: A message on the `/ws/sfu`
  endpoint conforming to the v3 contract (FR-090). Splits
  into two scopes per FR-090 (a):
  (i) **Transport-negotiation messages** — offer, answer,
  ICE candidate, transport reconnect / renegotiation —
  MUST carry a transport-attempt identifier scoped to the
  local SFUTransport so that stale negotiation messages
  can be discarded (EC-009).
  (ii) **Participant- / track-level metadata messages** —
  including media-state (mute / camera on-off / video
  source switch per FR-033), roster updates, and
  SFU-computed inspector summaries (FR-072 (iv), (v)) —
  MUST carry the relevant Participant / PublishedTrack /
  SubscribedTrack identifier and MUST NOT carry a
  transport-attempt identifier unless the v3 contract
  explicitly defines one for that message type.
  v3 messages MUST NOT appear on `/ws` or `/ws/mesh`.
- **EventLogEntry**: A human-readable record (FR-063)
  identifying an event type (FR-062), one or more
  scopes (FR-061), the affected Participant or
  SFUTransport or PublishedTrack/SubscribedTrack, a
  timestamp, and any relevant plain-language detail.
  Does NOT contain raw SDP, raw ICE candidate strings,
  TURN credentials, or media payloads (NFR-004).
- **SFUCostSummary**: The cost summary panel surface
  (FR-070) displaying: local SFU transport count
  (= **1** per Participant; DD-002 = A); uplink copies
  per published track (= 1); outgoing senders count
  (= 2 per fully-publishing Participant; audio + video,
  with screen replacing the video source rather than
  adding a sender per DD-004 = A); subscribed remote
  participant count (= `N − 1`); downstream forwarding
  deliveries per published track (= `N − 1`); downstream
  forwarding deliveries from this Participant
  (= activePublishedTrackCount × `N − 1`); server media
  role (= "forwarding (SFU)"); Participant count (= N);
  and the room topology label "SFU (1 bidirectional PC
  per participant)". Is a learning indicator only
  (NFR-009).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-S01**: 4 browsers can join `/sfu/demo`, all four grant
  camera and microphone, and within 30 seconds of the fourth
  join each browser sees three remote tiles displaying remote
  video and plays three remote audio streams forwarded by the
  SFU (US1 AS#3).
- **SC-S02**: At N=4, the SFU cost summary visibly differs
  from the mesh cost summary on at least four dimensions:
  local PC / SFU transport count, uplink copies per published
  track, room peer-pair count vs. server media role, and
  outgoing senders count (L20, L24, US2 AS#3, US2 AS#4).
- **SC-S03**: For each of L19, L20, L21, L22, L23, L24, and
  L25, a reviewer walking through the running SFU mode can
  point to at least one observable moment in the UI or event
  log where that learning outcome is realized. Coverage MUST
  total all 7 outcomes.
- **SC-S04**: When a participant leaves an SFU room
  ungracefully (closes tab, network drops), the remaining
  participants observe that participant transition to `left`
  and only that participant's tile and subscriptions are
  removed within **10 seconds** (US1 AS#5, US7 AS#1,
  EC-004).
- **SC-S04b**: When the local browser loses the `/ws/sfu`
  signaling connection, a `signaling-error` is surfaced to
  the local participant within **5 seconds** (EC-010); this
  is distinct from the remote-viewpoint SC-S04 measurement.
- **SC-S05**: The SFU media path is explicitly labeled as
  **browser ↔ SFU** on every remote tile, in the SFU
  learning panel (FR-074), and in the SFU cost summary
  (FR-070). No SFU-mode UI surface labels media as
  browser↔browser (L19, L23).
- **SC-S06**: The 001 quickstart at
  `specs/001-webrtc-1to1-call/quickstart.md` and the 002
  quickstart at `specs/002-webrtc-mesh-room/quickstart.md`
  both pass unchanged after 003 ships. The endpoints `/ws`
  and `/ws/mesh` continue to serve their respective v1 and
  v2 contracts. (NFR-005.)
- **SC-S07**: No media is persisted, recorded, or otherwise
  stored by either the browser application or the SFU media
  component. A reviewer walking through the running stack
  during a 4-person SFU session finds no recording artifacts
  on disk or in any service (NFR-003, Non-Goals).
- **SC-S08**: No raw SDP strings, raw ICE candidate strings,
  TURN credentials, or media payloads appear **rendered** in
  the SFU mode UI, event log, learning inspector, or any
  application log surfaced to the learner (NFR-004). The v3
  signaling contract MAY transmit raw SDP and raw ICE
  candidate payloads on the wire as required for browser↔SFU
  WebRTC negotiation (FR-090); SC-S08 measures rendering and
  logging, not wire transmission.

## Assumptions

- The learner runs the entire stack via `docker compose up
  --build` (per CLAUDE.md feedback memory and 001/002
  quickstarts) and accesses the routes `/`, `/mesh/:roomId`,
  and `/sfu/:roomId` via a browser on the host.
- Browser primitives (`RTCPeerConnection`, `getUserMedia`,
  `getDisplayMedia`, `RTCRtpSender`, `RTCRtpReceiver`) are
  available and behave per current spec; the project does
  not target browsers that lack these primitives (NFR-007).
- The four-participant SFU capacity (FR-011) is fixed for
  MVP. Configurable capacity, multi-room load balancing,
  and dynamic capacity negotiation are out of scope.
- DD-001..DD-005 were **locked by the 2026-05-03 clarify
  pass** (see §Clarifications → "Session 2026-05-03
  (Clarify pass)" and §Resolved Architectural Decisions for
  the resolved values). The plan MUST treat those decisions
  as canonical and MUST NOT reopen them. One residual UI-affordance
  choice (manual per-transport Reconnect button vs.
  leave/rejoin only) is bounded by FR-026 + Non-Goals
  ("no automatic reconnect, no automatic ICE restart, no
  automatic signaling reconnect") and is deferred to the
  plan phase as a surface-level decision.
- The SFU media component (DD-001) is reachable from the
  browser within the local Docker Compose network; STUN /
  TURN configuration for media reachability is set up in
  plan/implementation, not in this spec.
- The 001 v1 signaling contract (`/ws`) and the 002 v2
  signaling contract (`/ws/mesh`) are frozen for the
  duration of 003 development. Any change to those
  contracts is a separate feature, not part of 003.
- Participant identifiers, room identifiers, and presence
  semantics within an SFU room are scoped to the SFU mode
  only; they do NOT bleed into the 001 or 002 room model.
- The mesh-mode quickstart and 1:1-mode quickstart are
  authoritative regression targets for SC-S06; if either
  changes, this spec's SC-S06 wording MUST be reconciled.
- All SFU mode UI surfaces (cost summary, learning panel,
  event log, lifecycle indicators) are reachable inside
  the SFU room route without modal navigation, secondary
  windows, or browser devtools (FR-060, FR-071, NFR-009).
- The "SFU unavailable" state (FR-083) is a learning
  indicator, not a recovery mechanism. The MVP does NOT
  attempt automatic SFU failover, automatic reconnect, or
  automatic re-publication after an SFU failure
  (NFR-010).

## Non-Goals *(mandatory — constitution G-5)*

The following are explicitly out of scope for the SFU MVP.
Each is listed so that the scope boundary is unambiguous and
so that future feature work cannot silently expand the SFU
mode beyond its learning purpose.

- **No replacement of 001 or 002.** SFU mode is additive
  alongside the preserved 001 1:1 mode and 002 mesh mode
  (FR-001, FR-002, FR-003, NFR-005). All three modes
  remain reachable on their own routes and contracts.
- **No production conferencing platform.** SFU mode is a
  learning mode. It MUST NOT be marketed, deployed, or
  used as a production-grade conferencing product
  (NFR-003).
- **No authentication, authorization, or identity.** No
  login, no SSO, no per-user identity beyond a route
  parameter. Anyone with the URL can join.
- **No persistence.** No session history, no transcripts,
  no chat history (regardless of DD-003), no participant
  database. Restarting the SFU mode service loses all
  in-room state.
- **No recording.** Neither client-side nor server-side
  recording is in scope (L23, NFR-003, SC-S07).
- **No SFU clustering.** The MVP runs a single SFU media
  component (DD-001). No load balancing across SFU
  instances, no cross-instance state, no multi-region
  routing.
- **No managed TURN provisioning.** The MVP does NOT
  automate STUN/TURN credential issuance, lifecycle
  management, or rotation. Whatever STUN/TURN config is
  used for local development is configured manually in
  Docker Compose / environment variables (NFR-002,
  NFR-004).
- **No production deployment automation.** The MVP is
  Docker-Compose-local-development only. No Kubernetes,
  no autoscaling, no blue/green, no canary, no
  production CI/CD pipeline for the SFU mode.
- **No production monitoring stack.** No Prometheus,
  Grafana, OpenTelemetry, or other production telemetry
  integration for the SFU mode. The learning indicators
  in the UI are not telemetry (NFR-009).
- **No simulcast / SVC.** The MVP MUST NOT implement
  simulcast layers, SVC encodings, or any
  bandwidth-adaptive ladder beyond what the browser
  produces by default (NFR-010).
- **No codec selection UI.** The MVP MUST NOT expose
  codec selection to the learner. Whatever codecs the
  browser and SFU negotiate by default are used
  (NFR-010).
- **No Insertable Streams E2EE.** The MVP MUST NOT
  attempt end-to-end encryption of SFU media via
  Insertable Streams or any other mechanism. The MVP
  honestly states that SFU media is not E2EE
  (NFR-003).
- **No chat in SFU mode.** Chat is omitted from the SFU
  MVP (DD-003 = A, EC-015). 001 pairwise DataChannel chat
  and 002 mesh DataChannel chat remain reachable via their
  own routes. The v3 signaling contract MUST NOT carry chat
  message types and the SFU UI MUST NOT display a chat
  panel.
- **No file transfer.** No DataChannel-based file
  transfer in SFU mode.
- **No mobile native applications.** Browser only.
- **No room discovery / invite links / shareable
  permalinks.** Whatever the route parameter is, that
  is the room.
- **No admin / moderation / kick / mute-others
  controls.** Each participant controls only their own
  publication (FR-033, US5).
- **No subscribe-only observer mode.** Participants who
  fail to acquire camera and microphone are released
  rather than admitted as silent observers (FR-031,
  EC-001). A future "spectator" or "view-only" feature is
  out of scope.
- **No multi-region architecture.** Single Docker
  Compose deployment only.
- **No global chat ordering.** Chat is omitted from the
  SFU MVP entirely (DD-003 = A, EC-015), so cross-participant
  global ordering of chat messages is moot. Any future SFU
  chat feature MUST define its own ordering semantics; the
  003 MVP does not.
- **No production security claims beyond what is
  actually implemented.** The SFU mode MUST NOT claim
  protections (E2EE, hardened TURN, audited media
  path, recording-free guarantees beyond what NFR-003
  / SC-S07 actually verify) that the MVP does not in
  fact provide (Principle VII).
