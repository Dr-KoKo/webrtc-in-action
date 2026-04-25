# Feature Specification: Multi-party Mesh WebRTC Learning Room

**Feature Branch**: `002-webrtc-mesh-room`
**Created**: 2026-04-25
**Status**: Draft
**Input**: User description: "Multi-party Mesh WebRTC Learning Room — add a separate mesh mode (capacity 4) alongside the existing 001 1:1 codepath so a learner can directly compare 1:1 and mesh topologies, observe per-peer state and per-peer failure isolation, group-chat over RTCDataChannel mesh fan-out, and see why mesh scales as O(N²) and motivates SFU."

## Purpose & Learning Intent *(mandatory for this project)*

This feature is the **second learning milestone** of the `webrtc-lab` learning
project. It is **not** a replacement for the 1:1 baseline
(`001-webrtc-1to1-call`); that mode MUST remain intact and shippable. Instead,
this feature adds a **separate mesh mode** that lives alongside the 1:1 mode,
so a learner can run both modes in the same application and directly compare
how WebRTC behaves with one peer connection vs. with many.

### Constitutional alignment (Principle IX, Governance G-5)

Constitution v2.0.0 ratifies a strictly 1:1 MVP and Principle IX explicitly
preserves "extension points" for "a future migration to mesh or SFU". This
feature is the realization of the mesh extension point — it is **deliberately
scoped beyond the 1:1 MVP** as a learning expansion, in a **separate
codepath**.

In G-5 terms: this feature does **NOT** introduce multi-party semantics into
the 001 1:1 codepath. The 001 room model continues to enforce two reserved
slots, third-peer rejection, and all 001 acceptance criteria. The mesh
codepath is an additive, opt-in mode.

### Primary learning goal

Teach how WebRTC behaves when moving from a single 1:1 peer connection to a
multi-party mesh topology, and let the learner directly observe **why mesh
scales poorly and why an SFU is the natural next step**.

### Mesh-specific learning outcomes (stable IDs L13–L18)

The running mesh mode MUST let a learner directly observe and reason
about each of the following. Each outcome MUST have at least one
observable moment in the UI or event log (per SC-010). The original
001 learning outcomes (referred to as L1–L12) remain reachable through
the preserved 001 mode (FR-002, US2 AS#1, SC-002).

- **L13 — Per-PC connection independence**: each peer-pair has its
  own offer/answer, ICE, connection, and DataChannel lifecycle;
  offer/answer and ICE flows are **pairwise**, not room-global.
  Observable surfaces:
  - per-peer `connectionState`, `iceConnectionState`,
    `iceGatheringState`, and `signalingState` indicators (FR-023,
    FR-064) — the four lifecycle states mandated by Constitution
    Principle V — diverging at the same instant for two different
    remote peers (US3 AS#1, AS#3);
  - peer-scoped event log entries (FR-060, FR-061) carrying explicit
    peer ID / pair context for every pairwise event.

- **L14 — Mesh fan-out cost**: each participant maintains **`N − 1`**
  RTCPeerConnections and the room has **`N × (N − 1) / 2`**
  peer-pairs (the O(N²) shape); this scaling cost is exactly why an
  SFU exists as the natural next step (§Constitutional alignment).
  Observable surfaces:
  - mesh cost summary panel (FR-070, FR-071, NFR-007);
  - SC-008 step-by-step counts (1 → 0/0; 2 → 1/1; 3 → 2/3; 4 → 3/6);
  - outgoing-sender count growing as `2 × (N − 1)` per participant.

- **L15 — Per-PC failure isolation**: a failure of A↔B does NOT
  affect A↔C or A↔D (FR-025); the room MUST NOT enter a terminal
  failed state because of a single peer-pair failure (FR-065).
  Observable surfaces:
  - per-peer `failed` indicator on a single remote tile (US7 AS#1);
  - room-level **partial-mesh** indicator visually distinct from a
    whole-room failure (FR-065);
  - mesh cost summary `failed` count incrementing without
    `connected` count collapsing (FR-070).

- **L16 — Per-peer single outgoing video slot**: each participant has
  exactly **one** outgoing video slot; screen sharing replaces that
  slot's track on every connected remote peer via
  `RTCRtpSender.replaceTrack` (FR-040, FR-042). Multiple participants
  MAY screen-share concurrently (FR-041); WebRTC has **no native
  room-level "screen share" concept** — screen share is purely a
  per-peer outgoing-track replacement at each sender's
  RTCPeerConnection.
  Observable surfaces:
  - remote tile mirroring the remote's current outgoing video source
    (FR-043);
  - `local track replaced` event-log entries per peer-pair (FR-060);
  - mesh cost summary outgoing-sender count remaining `2 × (N − 1)`
    across track replacements (FR-070).

- **L17 — DataChannel fan-out**: a single group chat message produces
  **`N − 1`** DataChannel writes, one per remote peer (FR-051). There
  is no shared "room" DataChannel without an SFU.
  Observable surfaces:
  - per-message fan-out count in the sender's UI (FR-052, SC-006);
  - per-channel send-attempt entries in the peer-scoped event log
    (FR-052, FR-060);
  - chat UI rendering each sent message exactly once via local echo
    (FR-052a), distinct from the `N − 1` log entries.

- **L18 — Newcomer pairing-order independence**: when a newcomer
  becomes `media-ready`, the system creates only the **new**
  peer-pairs involving the newcomer; existing peer-pairs among
  already-present participants MUST NOT be paused, torn down, or
  renegotiated solely because the newcomer joined (FR-022a).
  Observable surfaces:
  - existing peer-pair tiles remaining in `connected` state during
    new pairings (US1 AS#5);
  - the newcomer's per-peer indicators progressing through
    `connecting` → `connected` independently for each existing peer
    without any state transition appearing on the existing-peers'
    own tiles for each other.

## Clarifications

### Session 2026-04-25

The following decisions were locked by the feature author before
specification. Each is integrated into the relevant requirement, acceptance
scenario, edge case, or assumption elsewhere in this document; this section
is the canonical record of the decision itself.

- Q: Is this feature a replacement for 001? →
  A: **No.** Mesh is an additive, separate mode. The 001 codepath remains
  intact and shippable. (See FR-001..FR-003 and Non-Goals.)
- Q: What is the mesh room capacity in MVP? →
  A: **Exactly 4 participants.** Configurable capacity is out of scope
  unless the plan explicitly tags it as optional, justified work.
  (See FR-011 and Assumptions.)
- Q: What transport carries group chat in the final MVP? →
  A: **RTCDataChannel mesh fan-out.** A group message is sent **once per
  remote peer** over that peer's DataChannel. Signaling-relayed group chat
  is **not acceptable** as the final mesh MVP transport; it MAY appear only
  as an interim build milestone. (See FR-050..FR-053.)
- Q: How does screen sharing work in mesh? →
  A: **Per-peer outgoing-track replacement, multiple concurrent sharers
  allowed.** Each participant has exactly **one outgoing video slot** (the
  same rule as 001). Starting screen share replaces that participant's
  outgoing video track on every connected remote peer. The application
  MUST NOT enforce a room-level single-sharer mutex. (See FR-040..FR-042.)
- Q: How is failure scoped? →
  A: **Per RTCPeerConnection.** If A↔B fails, A's connections to C and D
  MUST remain active if healthy. A failed peer-pair MUST be visible as a
  per-peer failure on the affected tile, NOT as a whole-room failure.
  (See FR-025 and US7.)
- Q: Does mesh inherit 001's two-phase join (admit → media-ready → pair)? →
  A: **Yes.** Joining a mesh room admits the participant into the
  `joined` state first; pairwise negotiations only begin after the
  participant transitions to `media-ready`. This preserves 001's
  "permission errors surface before signaling negotiation" learning
  outcome in the mesh setting. (See FR-013, FR-030, and Assumptions.)
- Q: Are SFU, simulcast, E2EE Insertable Streams, recording, file
  transfer, automatic ICE restart, or full-mesh auto-reconnect in scope? →
  A: **No** for all. (See Non-Goals.)
- Q: How does the running app distinguish 1:1 mode from mesh mode? →
  A: A clear, persistent, always-visible UI indicator (e.g., header badge
  "Mesh mode (capacity 4)") that is distinguishable from the 1:1-mode
  indicator at a glance. (See FR-004 and US2.)
- Q: What per-remote-peer state vocabulary does the roster expose? →
  A: Exactly `joined`, `media-ready`, `connecting`, `connected`, `failed`,
  `left`. The states preserve the two-phase join semantics from 001 but
  are scoped per remote peer, not whole-room. (See FR-013.)
- Q: For each mesh peer-pair, which participant creates the offer? →
  A: The participant with the **lower** server-assigned `admission_index`
  is the **offerer**; the participant with the **higher**
  `admission_index` is the **answerer**. This rule is applied **per
  peer-pair, not per room**. It preserves the 001 convention that the
  first admitted participant in a pairing is the offerer (001 FR-010a),
  while extending it to every peer-pair in a mesh room. Example: if
  participant D joins an existing mesh room containing A, B, C, then A,
  B, and C each create one offer to D (because each of them has a lower
  `admission_index` than D), and D answers each offer. The three
  offer/answer exchanges are independent because each peer-pair uses a
  separate RTCPeerConnection. No glare can occur because every peer-pair
  has exactly one deterministic offerer. (See FR-022 and Assumptions →
  "Deterministic offerer per peer-pair".)
- Q: Must every event-log entry tied to a remote peer carry peer context? →
  A: **Yes.** Every pairwise event-log entry MUST identify the peer-pair
  (peer ID or peer label). Examples: "offer created for peer B",
  "ICE candidate received from peer C", "DataChannel open with peer D",
  "peer-pair failed with peer B". (See FR-061.)
- Q: Does the MVP require globally consistent group-chat ordering across
  all peers? → A: **No.** Per-peer DataChannel ordering is preserved (a
  property of RTCDataChannel itself), but cross-peer global ordering is
  NOT a requirement of the MVP. (See FR-055.)
- Q: What does each remote tile display while a remote peer is sharing
  screen? → A: Whatever the remote participant's **current outgoing video
  source** is — camera, screen, or camera-off indicator — without any
  client-side priority rule beyond the single-outgoing-video-slot rule
  (FR-040). (See FR-043.)
- Q: How is partial-mesh failure surfaced to the learner? →
  A: When ≥1 peer-pair is `failed` while ≥1 peer-pair is `connected`, the
  UI MUST display a room-level **"partial mesh"** status that is visually
  distinct from a whole-room failure. The mesh room itself MUST NOT enter
  a terminal failed state because of one failed peer-pair. (See FR-025,
  FR-065, US7, EC-004.)
- Q: Are the mesh cost summary and per-peer indicators production
  telemetry? → A: **No.** They are **learning indicators only** — not
  alerting, aggregation, or longitudinal-analysis signals. The MVP MUST
  NOT emit metrics to external monitoring systems. (See NFR-008 and
  Non-Goals.)
- Q: When a participant fails media acquisition **after** admission but
  **before** any peer-pair exists, what visible state do other
  participants see? → A: A new state **`released`** is added to the
  FR-013 vocabulary, extending the locked set from 6 to **7** states
  (`joined`, `media-ready`, `connecting`, `connected`, `failed`,
  `released`, `left`). `released` mirrors 001's
  `participant_released_media_failed` event and explicitly carries
  **no peer-pair teardown semantics** because no peer-pair existed at
  the time of release. This distinguishes "released before pairing" from
  `left` (which always implies tile + RTCPeerConnection +
  RTCDataChannel teardown). (See FR-013, FR-014, EC-003, and Key
  Entities → Participant.)
- Q: Must the UI surface `iceGatheringState` per remote peer? →
  A: **Yes.** Per Constitution Principle V, the four lifecycle states —
  `connectionState`, `iceConnectionState`, `iceGatheringState`,
  `signalingState` — MUST all be visible per remote peer (in the
  always-on indicators of FR-064 and as transitions in the FR-060 event
  log). The earlier draft of this spec omitted `iceGatheringState`;
  this clarification corrects that omission across US3, FR-023, FR-064,
  FR-060, and SC-010.
- Q: For each peer-pair, who creates the per-pair RTCDataChannel? →
  A: The **lower-`admission_index` offerer** (per FR-022) MUST call
  `createDataChannel` **before** generating the SDP offer for that
  pair; the higher-`admission_index` answerer MUST NOT call
  `createDataChannel` for that pair and MUST register an
  `ondatachannel` handler. This is the per-pair generalization of 001's
  "offerer creates the DataChannel before the m-line" rule and prevents
  duplicate-channel and zero-channel implementation bugs. (See FR-050.)
- Q: How does each client learn every other participant's `peerId`,
  `admission_index`, and readiness state? →
  A: On admission, the signaling server MUST deliver an **initial
  mesh-roster snapshot** (FR-012a). Every subsequent presence/readiness
  change MUST be **broadcast** to all participants (FR-012b). The
  deterministic offerer rule (FR-022) MUST be evaluated against this
  roster on every client. Without these guarantees, the offerer rule
  is non-deterministic for a late joiner.
- Q: How many outgoing media senders does the cost summary report? →
  A: Exactly **`2 × (N − 1)`** in the happy path — one audio
  `RTCRtpSender` plus one video `RTCRtpSender` per remote peer.
  Switching the outgoing video source between camera and screen MUST
  use `RTCRtpSender.replaceTrack` (FR-040) which **does not change**
  the sender count; the MVP MUST NOT use `addTransceiver` to add a
  second video sender for screen share. At N = 4, Alice's count is
  exactly **6**. (See FR-070, US8, SC-008.)
- Q: What is the room ID validation rule for mesh mode? →
  A: The same rule as 001 (FR-002 coexistence requires a single,
  shared envelope): room IDs MUST be **trimmed before validation**,
  **case-sensitive**, **1–64 characters**, containing only printable
  ASCII letters / digits / hyphen / underscore / dot
  (`[A-Za-z0-9._-]`). Invalid IDs MUST be rejected by both client and
  server. (See FR-010 and EC-015.)
- Q: How is "ungraceful disconnect" split between local and remote
  viewpoints? →
  A: Two distinct success criteria:
  - **SC-005a (remote-session-ended)** — from remaining peers'
    viewpoint, the gone peer transitions to `left` within 10 seconds
    and only that peer's tile is removed;
  - **SC-005b (local-signaling-loss)** — from the dropping client's
    own viewpoint, a `signaling-error` is surfaced within 5 seconds;
    already-established peer-pairs MAY continue carrying media until
    they fail on their own.

  EC-012 is the local-viewpoint edge case; SC-005a / SC-005b name the
  measurable outcomes for each viewpoint.
- Q: Does the MVP include a manual per-pair Reconnect affordance for a
  failed peer-pair, or is whole-session leave/rejoin the only
  recovery? → A: **Manual per-pair Reconnect IS in scope**. FR-026
  defines it; activation creates a **fresh RTCPeerConnection** for
  that peer-pair only (NOT an ICE restart on the existing PC).
  Whole-room auto-reconnect, signaling auto-reconnect, full-mesh
  reconnect, and ICE restart proper remain out of scope. The
  Assumption "No automatic reconnect / no ICE restart proper"
  replaces the earlier over-restrictive "No reconnection / no ICE
  restart". (See FR-026, FR-021a, US7 AS#3, §Assumptions, §Non-Goals.)
- Q: How are pairwise messages distinguished between a failed
  attempt and a fresh attempt for the same peer-pair (so stale
  messages don't poison reconnect)? → A: Every pairwise negotiation
  attempt MUST carry a **pair-attempt identifier** (`pairEpoch`,
  `pairAttemptId`, or equivalent monotonic counter scoped per
  peer-pair) on every offer / answer / ICE / DataChannel-meta
  message. The exact format is a contract decision (FR-090); the
  spec only requires that some such mechanism exists and is checked
  before applying any pairwise message. (See FR-021a, FR-026.)
- Q: Are mesh-specific learning outcomes assigned stable IDs for
  traceability? → A: **Yes** — six outcomes **L13–L18** in
  §"Mesh-specific learning outcomes". Original 001 outcomes (treated
  as L1–L12) remain reachable through the preserved 001 mode. SC-010
  pegs reviewer-walkthrough coverage to L13–L18. (See §Mesh-specific
  learning outcomes, §SC-010.)
- Q: Is `room_full` a bare signaling message type, or a structured
  rejection result? → A: **Structured rejection result.** FR-011
  requires a clear, user-visible **room-full error**, but does NOT
  require a bare `room_full` envelope type. The v2 contract SHOULD
  prefer a typed `join_rejected` message with a structured
  `result: "join_rejected_room_full"` for symmetry with 001 v1's
  rejection shape. (See FR-011, FR-090.)
- Q: How is media-state propagated to all remote peers — client-side
  fan-out or server-side fan-out? → A: **Server-side fan-out.** The
  client sends ONE media-state update to the mesh signaling server;
  the server fans it out to every other participant in the same
  mesh room. This preserves 001's signaling-server-as-router model.
  Client-side fan-out (client iterates and sends N − 1 separate
  signaling messages for one state change) MUST NOT be used. The
  server still routes metadata only — never media payloads. (See
  FR-032, FR-024, FR-091.)
- Q: When a newcomer joins, may existing peer-pairs be paused or
  renegotiated as a side effect? → A: **No.** FR-022a explicitly
  forbids it: only the new peer-pairs involving the newcomer are
  created; existing pairs' connection / ICE / signaling /
  DataChannel state MUST be unchanged by the newcomer's pairing
  flow. This is the testable surface of L18. (See FR-022a, US1 AS#5,
  L18.)
- Q: Where does a sent group-chat message render — once locally,
  N − 1 times, or both? → A: **Exactly once** in the sender's chat
  UI as a local echo (FR-052a), independent of the N − 1
  per-channel send entries that appear in the peer-scoped event log
  (FR-060). The chat UI and the event log are two separate
  surfaces; conflating them would make a single sent message look
  like N messages. (See FR-052a, FR-052, FR-060.)
- Q: Is the 001 freeze a behavioral freeze or an implementation-shell
  freeze? → A: **Behavioral.** All 001 FRs / acceptance scenarios /
  success criteria / contract semantics MUST be preserved.
  Non-breaking implementation-shell refactors that preserve all 001
  behavior (mode router, shared utility extraction, file moves) ARE
  permitted; they are NOT prohibited by Non-Goals "No removal or
  rewrite". (See §Assumptions → "001 codepath untouched (behavioral
  freeze, not implementation freeze)".)
- Q: Is local-vs-remote-vs-pair state separation explicit, or implicit?
  → A: **Explicit** via FR-013a. Three distinct surfaces — local
  participant state, remote peer presence/readiness state, peer-pair
  lifecycle state — MUST be rendered without conflation. Peer-pair
  state is rendered ONLY on remote tiles; the local participant's own
  tile shows local readiness / media state but no pair state (no pair
  exists with oneself). (See FR-013a.)

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Join a mesh room and hold a 4-way call (Priority: P1)

Up to four participants open the application in separate browser windows or
devices, choose mesh mode, enter the same room ID, grant camera/microphone
permission, and end up with each participant seeing up to three remote tiles
with live audio and video.

**Why this priority**: This is the mesh MVP. Without it the feature does not
exist and none of the mesh learning outcomes can be demonstrated.

**Independent Test**: Open four browser windows pointing at the application
in mesh mode, enter the same mesh room ID in all four, accept camera/mic
prompts in all four, and confirm every participant sees three remote tiles
and hears the other three. Close one tab and confirm the remaining three
lose only the affected tile while their other peer-pairs continue.

**Acceptance Scenarios**:

1. **Given** a mesh room is empty, **When** Alice joins it, **Then** she
   sees her own preview, an empty roster of remote peers, and a "waiting
   for peers" room state.
2. **Given** Alice is alone in mesh room "demo-mesh", **When** Bob, Carol,
   and Dan join in turn, **Then** each new participant establishes a
   pairwise RTCPeerConnection with every existing participant, every
   participant sees a remote tile per remote peer with live audio and
   video, and the mesh now has **6 total peer-pairs** in the room.
3. **Given** the mesh room has four participants, **When** Eve attempts to
   join, **Then** Eve receives a clear `room_full` error, the room remains
   at four, and **no existing peer-pair is disturbed**.
4. **Given** four participants are connected, **When** Bob clicks Leave,
   **Then** Alice / Carol / Dan each tear down only their own
   RTCPeerConnection and RTCDataChannel to Bob, the affected remote tile is
   removed on each of them, and the remaining peer-pairs (A↔C, A↔D, C↔D)
   are unaffected.
5. **Given** Bob has just left, **When** Eve joins, **Then** Eve is
   admitted (the room had three reserved slots), Eve establishes a
   peer-pair with each of A / C / D, and the mesh stabilizes at four
   participants and 6 peer-pairs.

---

### User Story 2 — Compare 1:1 mode and mesh mode in the same build (Priority: P1)

A learner runs the 1:1 mode (existing 001 codepath) and the mesh mode (this
feature) in the same running application and directly compares the two —
seeing how a single peer connection differs from `N−1` per-peer connections.

**Why this priority**: Comparison is the **whole point of adding mesh as a
separate mode**. If the learner cannot run both modes in the same build, the
"1:1 vs mesh" lesson collapses.

**Independent Test**: Launch the application; run a 1:1 call between two
browsers in 1:1 mode, observe its lifecycle and event log; then enter mesh
mode in the same build, run a 4-way call, and observe how the lifecycle,
event log, and state indicators differ.

**Acceptance Scenarios**:

1. **Given** the running application supports both modes, **When** a learner
   opens 1:1 mode, **Then** all 001 acceptance criteria still hold and the
   001 codepath is observably unchanged.
2. **Given** the same running application, **When** a learner opens mesh
   mode, **Then** the mesh-mode UI exposes the per-peer indicators (US3),
   the peer-scoped event log (FR-060/FR-061), and the mesh cost summary
   (US8) that distinguish it from the 1:1 mode.
3. **Given** the learner has run both modes, **When** they compare the two
   sessions side by side, **Then** the differences in per-peer state,
   peer-pair count, DataChannel fan-out count, and screen-share track
   replacement scope are observable from the UI without opening browser
   devtools.

---

### User Story 3 — Observe per-peer connection state and lifecycle (Priority: P1)

For every remote peer, the mesh UI surfaces that peer's
`RTCPeerConnection.connectionState`, `iceConnectionState`,
`iceGatheringState`, and `signalingState` (where applicable), and a
peer-scoped event log entry stream. The four lifecycle states are the
visibility set mandated by Constitution Principle V.

**Why this priority**: Per the constitution, WebRTC lifecycle visibility is
non-negotiable (Principle V). In mesh, the only honest way to surface
lifecycle state is **per peer**, because peer-pair states diverge at the
same instant.

**Independent Test**: Join a mesh room with at least three participants; on
one participant, watch the per-peer indicators while the other two join,
leave, and rejoin; confirm each remote tile shows its own evolving
connection lifecycle.

**Acceptance Scenarios**:

1. **Given** Alice is connected to Bob and Carol, **When** Bob's
   RTCPeerConnection is `connected` and Carol's is still `connecting`,
   **Then** Alice's UI shows Bob as `connected` and Carol as `connecting`
   simultaneously, with no whole-room aggregation that hides the difference.
2. **Given** an event log on Alice's screen, **When** Alice scrolls through
   entries, **Then** every pairwise event (`offer created` / `offer
   received`, `answer created` / `answer received`, `ICE candidate sent` /
   `ICE candidate received`, `connection state changed`, `ICE state
   changed`, `ICE gathering state changed`, `signaling state changed`,
   `DataChannel opened` / `DataChannel closed`, `remote media state
   changed`, `screen share started` / `screen share stopped`,
   `peer pair failed`) carries an explicit **peer ID or peer label** so
   the learner can tell which peer-pair the entry concerns.
3. **Given** Alice's view of Bob and Carol, **When** Bob's connection
   transitions through `new` → `connecting` → `connected` while Carol's
   transitions through `new` → `connecting` → `failed`, **Then** Alice's
   per-peer indicators reflect each transition independently and the event
   log records each transition with the correct peer ID.

---

### User Story 4 — Group chat over DataChannel mesh fan-out (Priority: P2)

A participant types a group chat message; that message is delivered to every
connected remote peer over that peer's RTCDataChannel, and the UI makes the
**per-message fan-out count** visible.

**Why this priority**: Chat is the learning vehicle for **DataChannel
fan-out** in mesh, and is the most direct observable answer to "why does
mesh scale poorly for messages too?".

**Independent Test**: With four participants connected, send a group chat
message from one of them, confirm the other three receive it, and confirm
the sender's UI shows that the message was sent over **3 DataChannels** (one
per remote peer).

**Acceptance Scenarios**:

1. **Given** four participants are connected and every peer-pair's
   DataChannel is `open`, **When** Alice sends "hi everyone", **Then** Bob,
   Carol, and Dan all receive it over their respective DataChannels (A↔B,
   A↔C, A↔D), and Alice's UI indicates a fan-out of **3 sends**.
2. **Given** A↔C's DataChannel is in a non-open state (e.g., `connecting`
   or `closed`) while A↔B and A↔D are open, **When** Alice sends a group
   message, **Then** Bob and Dan receive the message, Carol does not, the
   sender's fan-out indicator clearly shows **2 of 3 delivered**, and a
   peer-scoped log entry records the skipped send to Carol.
3. **Given** RTCDataChannel is the locked final-MVP transport, **When** the
   spec is satisfied, **Then** group chat MUST NOT travel via the signaling
   server in the final MVP. A signaling-relayed chat is acceptable only as
   an interim build milestone, and whichever transport is active MUST be
   labeled in the per-peer log entry (signaling path vs. DataChannel path).

---

### User Story 5 — Toggle local mic / camera and observe per-peer remote state (Priority: P2)

Each participant can mute/unmute the microphone and turn the camera on/off
during an active mesh call. The change is reflected immediately in the local
UI and is communicated to every remote peer so each remote's tile of this
participant updates correctly.

**Why this priority**: Media controls are required UX and are also the
learning vehicle for "media state must be signaled per remote, not inferred
globally" in mesh.

**Independent Test**: With four participants connected, toggle mic and
camera on one participant; confirm the other three each see that
participant's tile update.

**Acceptance Scenarios**:

1. **Given** Alice is connected to Bob, Carol, and Dan, **When** Alice
   mutes her mic, **Then** Alice's local UI shows muted, and on each of
   Bob / Carol / Dan, Alice's remote tile shows muted via an explicit
   media-state signaling message (FR-032).
2. **Given** Alice is connected to Bob and Carol but A↔D is in failed
   state, **When** Alice toggles her camera off, **Then** Bob and Carol
   see Alice's camera-off indicator update; Dan's view of Alice is
   irrelevant because the peer-pair is failed (no media-state propagation
   is expected over a failed pair, and this is consistent with FR-025
   per-peer failure isolation).

---

### User Story 6 — Multiple concurrent screen sharers (Priority: P2)

Two or more participants can screen-share at the same time. Each sharer's
outgoing video slot becomes the screen track on every connected remote peer.

**Why this priority**: Screen sharing demonstrates the **per-peer
outgoing-track replacement** rule generalizing from 001 to mesh, and the
**deliberate absence** of a room-level "only one sharer" mutex.

**Independent Test**: With three participants connected, start screen
sharing on two of them simultaneously and confirm the third participant
sees both screens (one per remote tile, replacing each sharer's camera).

**Acceptance Scenarios**:

1. **Given** Alice and Bob are connected to Carol, **When** Alice starts
   screen sharing, **Then** Alice's outgoing video track is **replaced** by
   the screen track on every connected remote peer (Bob and Carol see
   Alice's screen instead of Alice's camera), the camera→screen swap is
   recorded as one event per peer-pair in Alice's event log, and the
   application does not require Alice to hold any room-level "single
   sharer" lock.
2. **Given** Alice is already screen-sharing, **When** Bob also starts
   screen-sharing, **Then** Bob's outgoing video is replaced by his screen
   on every connected remote peer (Alice and Carol now see Bob's screen on
   Bob's tile), Alice's screen continues unchanged on her tile, and the
   application does **not** block, prompt, or auto-stop Alice's share.
3. **Given** Alice is screen-sharing, **When** Alice clicks "Stop sharing"
   in the app **or** uses the browser's native stop control, **Then**
   Alice's outgoing video track reverts to the camera (if available) on
   every connected remote peer, or to the camera-off indicator if the
   camera is off / absent — same rule as 001 — and the revert is logged
   per peer-pair.

---

### User Story 7 — Failure isolation per RTCPeerConnection (Priority: P1)

A failure in one peer-pair (ICE failure, DTLS failure, transport drop) is
displayed only on the affected remote tile. All other peer-pairs that are
still healthy continue without interruption.

**Why this priority**: Failure isolation is the **defining behavioral
difference** between mesh and a single 1:1 connection: the room does not die
when one pair dies. The mesh learning goal collapses if the UI conflates one
failed pair with whole-room failure.

**Independent Test**: With four participants connected, deliberately
disrupt one peer-pair (e.g., simulate a network failure between Alice and
Bob via local conditions) and confirm only A↔B is shown as failed while
A↔C, A↔D, B↔C, B↔D, and C↔D remain in their actual states.

**Acceptance Scenarios**:

1. **Given** Alice is connected to Bob, Carol, and Dan, **When** A↔B's ICE
   transitions to `failed`, **Then** Alice's UI marks Bob's tile as failed
   (per-peer terminal `failed` state), Alice's tiles for Carol and Dan
   remain untouched, the mesh cost summary updates `failed` count by one,
   Alice's event log records a `peer pair failed` entry tagged with Bob's
   peer ID, and **no whole-room cleanup is triggered**.
2. **Given** A↔B is in failed state, **When** Alice clicks a per-peer
   "Leave / Remove" affordance on Bob's tile (or simply clears the
   failed tile), **Then** the recovery action is scoped to A↔B only
   and does not tear down A↔C or A↔D. (Automatic ICE restart and
   full-mesh reconnect remain out of scope per Non-Goals; manual
   per-peer recovery is the MVP.)
3. **Given** A↔B is in `failed` state while A↔C and A↔D remain
   `connected`, **When** Alice clicks the per-pair **Reconnect**
   affordance on Bob's tile (FR-026), **Then** the application tears
   down only the failed A↔B RTCPeerConnection and RTCDataChannel and
   creates a **fresh pairing attempt** for A↔B (new
   RTCPeerConnection, new pair-attempt identifier per FR-021a, new
   offer/answer/ICE flow under FR-022). A↔C and A↔D MUST remain in
   `connected` state throughout (no pause, no renegotiation — per
   FR-022a invariants applied to non-newcomer pairs as well). Any
   late-arriving stale offer/answer/ICE/DataChannel-meta messages
   from the failed attempt MUST be dropped because their
   pair-attempt identifier no longer matches.

---

### User Story 8 — Mesh cost summary makes O(N²) visible (Priority: P2)

The mesh UI shows a small summary panel that quantifies the cost of mesh
from this client's perspective: how many remote peers, how many local
RTCPeerConnections, how many local RTCDataChannels, how many outgoing media
senders, and how many peer-pairs are connected / failed / pending.

**Why this priority**: The numeric, real-time cost panel is what makes the
**O(N²) intuition concrete** for the learner. Without it, the
mesh-vs-SFU lesson is academic.

**Independent Test**: Join a mesh room with one peer, then two, then three
remote peers; observe the cost summary's per-local counts grow as `N−1` per
participant; confirm the room-wide peer-pair total grows as `N×(N−1)/2`
across the participants' summaries.

**Acceptance Scenarios**:

1. **Given** Alice is alone in a mesh room, **When** the cost summary is
   read, **Then** it shows local peers = 0, RTCPeerConnections = 0,
   RTCDataChannels = 0, outgoing media senders = 0, and peer-pairs
   `connected` = 0 / `failed` = 0 / `pending` = 0.
2. **Given** Alice is connected to Bob, Carol, and Dan, **When** the cost
   summary is read on Alice's UI, **Then** it shows local peers = 3,
   RTCPeerConnections = 3, RTCDataChannels = 3, **outgoing media
   senders = 6** (3 audio + 3 video; one of each per remote peer, per
   FR-070), peer-pairs `connected` = 3, and `failed` + `pending` = 0
   in the happy path.
3. **Given** the room transitions from 1 to 4 participants, **When** the
   learner reads each participant's cost summary at each step, **Then** the
   numbers grow as N−1 per local participant and as N×(N−1)/2 in total
   peer-pairs across the room (1 → 0 / 0; 2 → 1 / 1; 3 → 2 / 3; 4 → 3 / 6).

---

### Edge Cases

The following cases MUST be handled explicitly. Each must be observable in
the UI and/or per-peer event log; silent failure is not acceptable.

- **EC-001 — Joining an empty mesh room** → UI enters "waiting for peers"
  room state, with the local participant visible in the roster and zero
  remote tiles.
- **EC-002 — 5th participant attempts to join** → join is rejected with a
  clear, user-visible `room_full` error. The existing four-way mesh is
  unaffected (no peer-pair is renegotiated or torn down).
- **EC-003 — Camera/microphone permission denied** → joiner is released
  cleanly without establishing any peer-pair. Two sub-cases per the
  two-phase join model carried over from 001:
  - **Pre-admission media failure** — the client could not acquire
    local media before sending the join request. The join is never
    accepted; existing participants never see this peer; the local
    UI surfaces a permission-error and returns to the lobby.
  - **Post-admission media failure** — the client was admitted into
    the `joined` state but its media acquisition then failed.
    Existing participants see the peer transition `joined` →
    `released` (see FR-013, FR-014); **no peer-pair teardown** is
    performed because no peer-pair was ever established. The
    released peer's roster entry is removed from every other
    participant's roster, and the local UI of the failed joiner
    surfaces the permission-error and returns to the lobby.
- **EC-004 — Peer-pair ICE failure** → the affected peer-pair enters
  per-peer terminal `failed` state on both endpoints; all other peer-pairs
  continue. The mesh cost summary updates `failed` count by one. **No
  room-wide cleanup is triggered.**
- **EC-005 — Peer leaves mid-call (graceful)** → every remaining peer tears
  down its RTCPeerConnection and RTCDataChannel to the leaver and removes
  the corresponding tile; other peer-pairs are untouched.
- **EC-006 — Peer leaves mid-call (ungraceful: tab close, browser crash,
  network drop)** → from the **remaining peers' viewpoint**, detected
  within a bounded time (see SC-005a); behavior identical to a
  graceful leave on the remaining peers (per-peer cleanup per FR-014
  `left` branch). From the **dropping peer's own viewpoint**, see
  EC-012 / SC-005b for local signaling-loss handling.
- **EC-007 — Peer refreshes the page** → the refreshed peer is treated as a
  fresh participant; remaining peers see the prior session as a leave and
  the refreshed peer as a new join with a new peer ID.
- **EC-008 — DataChannel for one peer is not open when a group chat
  message is sent** → message is delivered only to peers whose DataChannel
  is open; the sender's UI shows the partial fan-out count (e.g.,
  "2 of 3 delivered") and a peer-scoped log entry records the skipped
  peer(s). The MVP MUST NOT silently drop, queue, or persist the message.
- **EC-009 — Screen share started by a participant whose camera is off** →
  outgoing video slot becomes the screen track for every connected remote
  peer; on stop, the slot reverts to the camera-off indicator (same rule
  as 001 generalized to N−1 remote peers).
- **EC-010 — Screen share stopped via the browser's native control** →
  application detects the end-of-share event and performs the same
  per-peer revert behavior as the in-app stop button, with one log entry
  per affected peer-pair.
- **EC-011 — Multiple concurrent sharers** → each sharer's outgoing video
  slot independently shows their own screen; no room-level mutex is
  enforced and no auto-stop of other sharers is triggered.
- **EC-012 — Local WebSocket signaling disconnects mid-mesh** → strictly
  a **local-viewpoint** failure class (matched to SC-005b; compare
  SC-005a for the remote viewpoint). The local UI MUST surface a
  `signaling-error` state and emit a `signaling error` event-log
  entry. The MVP MUST NOT auto-reconnect signaling; manual leave/rejoin
  is the recovery. Already-established peer-pairs MAY continue carrying
  media and DataChannel traffic until they fail on their own; any such
  subsequent peer-pair failure is handled per EC-004 / FR-025. From the
  **remote** participants' viewpoint, this client losing signaling is
  observed identically to "session ended" and is handled per SC-005a:
  the remote peers will see this client as `left` within ~10 seconds
  once the server detects the dropped socket. New pairings (e.g., a
  late joiner arriving while the local signaling socket is dropped)
  cannot be initiated locally because pairwise role assignment
  (FR-022) requires the roster broadcast (FR-012b), which is gone.
- **EC-013 — A peer-pair fails while a group chat message is mid-flight**
  → at the sender, the in-flight send for that peer is reported as failed
  in the peer-scoped event log; other peers' deliveries are unaffected.
- **EC-014 — Glare (simultaneous offers) on a peer-pair** → MUST NOT occur
  under the deterministic per-peer-pair offerer rule (FR-022). If the
  implementation ever observes two offers in flight for the same peer-pair,
  it MUST surface an `error occurred` log entry tagged "offer collision"
  and treat it as a protocol-level bug rather than a recoverable state
  (consistent with 001 EC-013).
- **EC-015 — Invalid mesh room ID** → the client MUST locally reject any
  room ID that fails FR-010 validation (empty after trim, > 64
  characters, or containing characters outside `[A-Za-z0-9._-]`) with
  a clear, user-visible error **before** any signaling message is
  sent. If an invalid room ID nevertheless reaches the signaling
  server, the server MUST reject the join with a contract-defined
  error code (e.g., `join_rejected_invalid_room_id`; the exact code is
  a plan/contract decision per FR-090) and MUST NOT create or modify
  any room state. No peer-pair side effects occur in either case.

## Requirements *(mandatory)*

### Functional Requirements

**Mode coexistence with 001**

- **FR-001**: The application MUST expose a **mesh mode** as a separate
  room mode, route, or UI mode that lives alongside the existing 1:1
  mode.
- **FR-002**: The 001 1:1 codepath MUST remain intact: all 001 functional
  requirements, acceptance scenarios, success criteria, and constitutional
  guarantees continue to hold without modification.
- **FR-003**: A learner MUST be able to run the 1:1 mode and the mesh mode
  separately within the same running application build (different routes,
  modes, or rooms — the plan chooses the exact mechanism).
- **FR-004 (Mesh-mode UI indicator)**: While in mesh mode, the application
  MUST display a clear, persistent, always-visible UI indicator (e.g., a
  header badge reading "Mesh mode (capacity 4)" or equivalent) that is
  visually distinguishable at a glance from the 1:1-mode indicator. The
  learner MUST be able to identify which mode they are observing without
  inspecting the URL, opening browser developer tools, or reading log
  entries. The indicator MUST remain visible for the entire duration of
  the mesh session (lobby, in-room, leaving).

**Mesh room & presence**

- **FR-010 (Room ID format and validation)**: The system MUST allow a
  user to enter a room ID and join the mesh room identified by that ID
  **in mesh mode**. Room ID validation MUST match 001's rule (carried
  over verbatim per FR-002 coexistence): room IDs MUST be **trimmed of
  leading and trailing whitespace before validation**, MUST be
  **case-sensitive**, MUST be between **1 and 64 characters** in
  length after trimming, and MUST contain only printable ASCII
  letters / digits / hyphen (`-`) / underscore (`_`) / dot (`.`)
  (regex `^[A-Za-z0-9._-]{1,64}$`). The client MUST refuse invalid
  room IDs locally (input validation) before sending any signaling
  message, and the signaling server MUST also refuse invalid room IDs
  on receipt (defense in depth). See EC-015.
- **FR-011**: A mesh room MUST admit a maximum of **4 participants** by
  default. The 5th attempted participant MUST be rejected with a clear,
  user-visible **room-full** error within the latency bound of SC-004
  (no waiting queue, no auto-retry, no existing peer-pair disturbance).
  The exact v2 signaling shape carrying this rejection is defined by
  the mesh signaling contract (FR-090); the spec does **NOT** require
  a bare `room_full` envelope type. The v2 contract SHOULD prefer a
  typed `join_rejected` message with a structured result/reason
  (e.g., `result: "join_rejected_room_full"`) for symmetry with 001
  v1's rejection shape (001 spec FR-011a / contract §join_rejected),
  unless planning explicitly justifies otherwise.
- **FR-012**: The system MUST display a **roster** of every participant in
  the mesh room, including the local participant and each remote peer with
  a stable peer identifier or label.
- **FR-012a (Initial mesh-roster snapshot on admission)**: On admission,
  the signaling server MUST deliver to the newly-admitted participant a
  complete **mesh-roster snapshot** containing, for every participant
  currently in the room (including the newly-admitted participant): the
  stable `peerId`, the server-assigned `admission_index` (FR-022), and
  the current presence/readiness state (FR-013). The newly-admitted
  client MUST NOT begin pairwise role assignment (FR-022) before
  receiving this snapshot. The snapshot delivery MUST be recorded in
  the event log as `mesh roster snapshot received` (FR-060).
- **FR-012b (Roster updates broadcast on every state change)**: Every
  subsequent presence/readiness state change for any participant —
  `joined`, `media-ready`, `connecting`, `connected`, `failed`,
  `released`, `left` — MUST be **broadcast** by the signaling server
  to all participants currently in the mesh room. Each client's
  view of the roster MUST be derived deterministically from the
  initial snapshot (FR-012a) plus the ordered stream of update
  messages (FR-012b); no out-of-band side channel is permitted. The
  deterministic offerer rule (FR-022) MUST evaluate against this
  roster at the moment a peer-pair becomes eligible for negotiation
  (i.e., when both participants in the pair have reached
  `media-ready`). Each broadcast MUST be recorded in the event log
  as `mesh roster updated` (FR-060).
- **FR-013**: For each remote peer, the system MUST display a
  **presence/readiness state** drawn from this exact 7-element set:
  `joined`, `media-ready`, `connecting`, `connected`, `failed`,
  `released`, `left`. Semantics:
  - `joined` — admitted into a mesh-room slot, **not yet** media-ready;
  - `media-ready` — local media acquired, eligible for pairing;
  - `connecting` — pairwise WebRTC negotiation in progress with this
    peer (offer/answer or ICE not yet `connected`);
  - `connected` — peer-pair RTCPeerConnection has reached `connected`;
  - `failed` — per-peer terminal failure of a peer-pair that **had
    been established** (see FR-025);
  - `released` — the peer was admitted (`joined`) but **never reached
    `media-ready`** because their local media acquisition failed
    post-admission (e.g., camera/mic permission denied after the
    server admitted them). Mirrors 001's
    `participant_released_media_failed`. **No peer-pair teardown** is
    implied because no peer-pair existed for this peer; this is the
    distinguishing semantic from `left`. See EC-003 and FR-014;
  - `left` — the peer has left the room **after** at least one
    peer-pair was established (graceful leave, ungraceful tab close,
    network loss, or remote signaling drop). Implies tile removal and
    teardown of every peer-pair the local participant held with this
    peer (see FR-014, SC-005a).

  These states preserve the same two-phase join semantics as 001 but
  are scoped **per remote peer**, not whole-room. The local participant
  observes one such state for every other participant in the roster
  (FR-012), and the state MUST be visible without opening browser
  developer tools.
- **FR-013a (State separation: local vs remote vs pair)**: The UI
  MUST render **three distinct state surfaces** without conflating
  them:
  1. **Local participant state** — the local participant's own
     lifecycle (`joining` → `joined` → `media-ready` → `in-room` →
     `leaving` / `left` / `failed`, with side-exit `joined` →
     `released`) and local media state (mic / camera / screen-share
     on/off). Answer to "what state am I in?"
  2. **Remote peer presence/readiness state** — for each remote peer
     in the roster, exactly one of the 7 states defined in FR-013.
     Answer to "what state is that remote peer in, from my
     perspective?"
  3. **Peer-pair lifecycle state** — for each (local, remote) pair,
     `RTCPeerConnection.connectionState`, `iceConnectionState`,
     `iceGatheringState`, `signalingState`, and DataChannel state
     (FR-023, FR-064). Answer to "what state is the connection
     **between us** in?"

  The roster (FR-012) lists the local participant alongside remote
  peers, but **peer-pair lifecycle state is rendered ONLY on remote
  tiles** (no peer-pair exists with oneself). UI implementations and
  tests MUST distinguish these three surfaces; conflating them — for
  example, rendering the local participant's own `media-ready` as a
  pair `connectionState`, or rendering a remote peer's presence
  state in the pair-state column — is a defect.
- **FR-014 (Per-peer cleanup, by terminal state)**:
  - When a peer transitions to **`left`** (graceful leave, ungraceful
    disconnect, network loss, or remote signaling drop after at least
    one peer-pair was established), the system MUST tear down only
    that peer's pairwise RTCPeerConnection and RTCDataChannel, remove
    its remote tile, and remove its roster entry, leaving every other
    peer-pair untouched.
  - When a peer transitions to **`released`** (post-admission media
    failure before any peer-pair was established), **no peer-pair
    teardown** is performed (no pair existed). The system MUST remove
    the released peer's roster entry on every other participant and
    record a `peer released` event-log entry (see FR-060).
  - Per-peer cleanup MUST NOT cascade to any other peer-pair (FR-025).

**Pairwise WebRTC connections**

- **FR-020**: For every (local participant, remote participant) pair in the
  mesh room, the system MUST establish exactly **one RTCPeerConnection**
  between them, via offer/answer exchange and ICE candidate exchange,
  before audio/video flows.
- **FR-021**: All offer/answer and ICE messages MUST be **pairwise**: every
  signaling message that participates in a negotiation MUST identify the
  peer-pair it belongs to (via sender + recipient peer IDs or an explicit
  peer-pair identifier), and the application MUST never apply an
  offer/answer or ICE candidate intended for one peer-pair to another
  peer-pair.
- **FR-021a (Pair attempt identity)**: Every pairwise negotiation
  attempt MUST be distinguishable from prior attempts for the **same**
  peer-pair. The plan/contract MUST define a **pair-attempt
  identifier** (e.g., `pairEpoch`, `pairAttemptId`, or an equivalent
  monotonic counter scoped per peer-pair) carried on every pairwise
  signaling message — offer / answer / ICE candidate / DataChannel
  meta — so that late-arriving messages from a previously-failed
  attempt cannot be applied to a fresh attempt for the same pair.
  This invariant is a hard prerequisite for the manual
  reconnect-this-pair flow (FR-026); without it, stale messages can
  poison a fresh pairing attempt.
- **FR-022a (Existing pair stability on newcomer join)**: When a
  newcomer participant becomes `media-ready`, the system MUST create
  only the **new** peer-pairs that involve the newcomer. Existing
  `connected` or `connecting` peer-pairs among already-present
  participants MUST NOT be paused, torn down, or renegotiated solely
  because the newcomer joined; their `connectionState`,
  `iceConnectionState`, `iceGatheringState`, `signalingState`, and
  DataChannel state MUST be unchanged by the newcomer's pairing
  flow. This is the testable surface of L18 (newcomer pairing-order
  independence) and aligns with US1 AS#5.
- **FR-022 (Deterministic offerer per peer-pair)**: For each peer-pair,
  the deterministic offerer/answerer rule MUST be:
  - **offerer** = the participant with the **lower** server-assigned
    `admission_index` in the pair;
  - **answerer** = the participant with the **higher** server-assigned
    `admission_index` in the pair.

  `admission_index` is a stable, monotonically-increasing integer
  issued by the signaling server at admission time and broadcast to
  every participant in the room as part of the roster. The rule MUST
  be applied **per peer-pair, not per room**, and MUST select **exactly
  one offerer per peer-pair per pairing attempt**, eliminating glare by
  construction in the happy path (`signalingState` MUST never be
  observed in `have-local-offer` and `have-remote-offer` simultaneously
  for the same peer-pair).

  This rule is the per-pair generalization of 001 FR-010a (in 001, the
  first admitted of two participants is the offerer); applying the same
  rule to every unordered pair `{P_i, P_j}` in a mesh room yields a
  single, consistent offerer-selection convention across both modes.
  Concrete example: if participant D joins a mesh room already
  containing A, B, C (each with a lower `admission_index` than D), then
  A, B, and C each create one offer to D, and D answers each offer.
  The three exchanges are independent because each peer-pair has its
  own RTCPeerConnection.

  The signaling contract (FR-090) MUST encode this rule explicitly,
  including a per-pair role assignment delivered by the server at the
  moment each peer-pair becomes eligible for negotiation (i.e., when
  both participants of the pair have reached `media-ready`). Clients
  MUST NOT initiate `createOffer` for a peer-pair until they receive
  the `offerer` role for that pair. See Assumptions
  ("Deterministic offerer per peer-pair") and EC-014.
- **FR-023**: For each remote peer, the system MUST display **per-peer**
  indicators for `RTCPeerConnection.connectionState`,
  `iceConnectionState`, **`iceGatheringState`**, and `signalingState`
  (where applicable), updated live as they change. These four
  lifecycle states together are the visibility set mandated by
  Constitution Principle V; omitting any of them violates the
  constitution.
- **FR-024**: Media (audio, video, screen share) for any peer-pair MUST
  flow over the WebRTC media transport — directly between peers or via a
  TURN relay when NAT traversal requires it. Media MUST NEVER flow through
  the application signaling server, identical to 001 FR-011.
- **FR-025**: A failure in one peer-pair (ICE failure, DTLS failure,
  transport-level error) MUST place **only that peer-pair** in a per-peer
  terminal `failed` state. The system MUST NOT propagate that failure to
  any other peer-pair. The system MUST NOT enter a whole-room `failed`
  state in response to a single peer-pair failure.
- **FR-026 (Manual reconnect-this-pair)**: When a peer-pair is in
  `failed` state (per FR-025), the UI MUST expose a **per-pair manual
  Reconnect affordance**. Activating it MUST:
  1. tear down the failed pair's RTCPeerConnection and RTCDataChannel
     locally;
  2. create a **fresh pairing attempt** for that peer-pair (a new
     RTCPeerConnection, a new pair-attempt identifier per FR-021a,
     and a new offer/answer/ICE flow under FR-022);
  3. affect **only** that peer-pair — no other healthy or pending
     peer-pair MUST be paused, renegotiated, or torn down as a side
     effect.

  The reconnect attempt MUST be a fresh pairing attempt, **NOT** an
  ICE restart on the existing PC; ICE restart proper remains out of
  scope (§Non-Goals, §Assumptions). The pair-attempt identifier
  (FR-021a) ensures stale offer/answer/ICE/DataChannel-meta messages
  from the failed attempt are dropped and cannot be applied to the
  fresh attempt. Whole-room auto-reconnect, signaling auto-reconnect,
  and full-mesh reconnect remain out of scope.

**Local media & per-peer media state**

- **FR-030**: Each participant MUST acquire camera and microphone access
  before pairwise negotiation begins, following the same two-phase join
  model as 001: client is admitted into the `joined` state, acquires
  media, transitions to `media-ready`, and only then is included in
  pairing. Until a participant reports `media-ready`, no peer-pair
  negotiation MUST be initiated involving them.
- **FR-031**: Each participant MUST be able to mute/unmute their microphone
  and turn their camera on/off during an active mesh call. The local UI
  MUST reflect the change immediately.
- **FR-032 (Media-state fan-out)**: Whenever a participant changes
  microphone, camera, or screen-share state, the client MUST notify
  **every connected remote peer** of the new state via an explicit
  media-state signaling update, so each remote's per-peer media-state
  indicator (FR-033) updates deliberately rather than being inferred
  from packet flow.

  **Direction (locked for MVP)**: the client sends **one**
  media-state update to the **mesh signaling server**, and the server
  **fans it out** to every other participant in the same mesh room.
  This preserves 001's signaling-server-as-router model for metadata
  coordination. The client MUST NOT implement client-side fan-out for
  media-state updates (i.e., the client does NOT iterate over its
  N − 1 peers and send N − 1 separate signaling messages for one
  state change).

  The signaling server routes this metadata only and MUST NOT relay
  any audio, video, or screen-share **media payload** — that
  separation, identical to 001 (FR-024, FR-091), is preserved.
- **FR-033**: For each remote peer, the system MUST display **per-peer**
  indicators for that peer's microphone, camera, and screen-share state.

**Screen sharing**

- **FR-040**: Each participant MUST have exactly **one outgoing video
  slot** (the same rule as 001 FR-017). Starting screen share MUST replace
  that participant's outgoing camera track with the screen track on every
  connected remote peer (via `RTCRtpSender.replaceTrack` or renegotiation —
  plan choice; the chosen mechanism MUST appear in the per-peer event log).
- **FR-041**: The application MUST allow **multiple participants to
  screen-share at the same time**. The application MUST NOT enforce a
  room-level single-sharer mutex, MUST NOT prompt a participant to confirm
  they are about to "take over" the share, and MUST NOT auto-stop another
  participant's screen share when a new sharer starts.
- **FR-042**: Stopping screen share — whether via the application UI button
  or the browser's native "Stop sharing" control — MUST revert the sharer's
  outgoing video track on every connected remote peer back to the camera if
  available, or to the camera-off indicator if the camera is off / absent
  (same rule as 001 FR-018 / FR-019, generalized to N−1 remote peers).
- **FR-043 (Remote tile mirrors current outgoing video source)**: Each
  remote tile MUST display whatever the remote participant's **current
  outgoing video source** is — camera frames, screen frames, or the
  camera-off indicator — without imposing any client-side priority
  between camera and screen beyond the single-outgoing-video-slot rule
  (FR-040). When two or more remote participants are screen-sharing
  concurrently (FR-041), each remote tile independently shows its own
  remote's current source; the local UI MUST NOT promote, demote, or
  otherwise re-rank tiles based on screen-share state.

**Group chat over RTCDataChannel mesh fan-out**

- **FR-050 (DataChannel ownership per peer-pair)**: For each peer-pair,
  the system MUST open exactly **one RTCDataChannel** to carry group
  chat in the final MVP. Ownership of the creation call MUST be
  unambiguous:
  - the **lower-`admission_index` offerer** for the pair (per FR-022)
    MUST call `RTCPeerConnection.createDataChannel` **before**
    creating the SDP offer for that pair;
  - the **higher-`admission_index` answerer** for the pair MUST NOT
    call `createDataChannel` for that pair and MUST register an
    `ondatachannel` handler to receive the channel.

  This rule is the per-pair generalization of 001's "offerer creates
  the DataChannel before the m-line" convention; it prevents both
  duplicate-channel ("two `createDataChannel` calls per pair") and
  zero-channel ("neither side creates the channel") implementation
  bugs and must be encoded in the signaling contract (FR-090).
- **FR-051**: Sending a group chat message MUST be implemented as
  **fan-out**: the message is sent **once per remote peer** over that
  peer's DataChannel. There MUST NOT be a single shared "room" DataChannel
  that all participants subscribe to (no such construct exists in mesh
  without an SFU).
- **FR-052**: The system MUST display, for every group chat message the
  local participant sends, the **fan-out count** — how many DataChannel
  sends were attempted and how many succeeded. Skipped peers (e.g.,
  DataChannel not `open`) MUST be visible as a per-peer "send skipped"
  log entry.
- **FR-052a (Chat local echo separated from per-channel send log)**:
  When a participant sends a mesh group chat message, the sender's
  **chat UI** MUST render the message **exactly once** as a local
  message, immediately upon send, **independent of** the `N − 1`
  per-peer DataChannel writes performed by fan-out (FR-051, FR-052).
  Local echo MUST NOT depend on round-trip confirmation from any
  remote peer — the message appears in the sender's chat list as
  soon as the local user submits it. The peer-scoped event log
  (FR-060) separately records the `N − 1` per-channel send attempts
  (one entry per remote peer); these log entries MUST NOT cause the
  chat UI to render the same message N times. **Invariant**: chat UI
  shows N=1 message; event log shows N − 1 send-attempt events for
  that message. This separation is the testable surface tying L17
  (DataChannel fan-out) to the user-facing chat experience.
- **FR-053**: Signaling-relayed group chat MAY be used as an interim build
  milestone while DataChannel fan-out work is in progress, but the **final
  MVP MUST use DataChannel fan-out** unless the plan documents a strong,
  explicit reason to deviate. Whichever transport is active, the UI/log
  MUST make it observable per chat message whether the message traveled
  over the signaling path or the peer-to-peer DataChannel path.
- **FR-054**: Chat messages MUST be trimmed of leading/trailing whitespace,
  MUST be rejected if empty after trim, MUST be limited to a maximum
  length of **500 characters**, and MUST be rendered as text — never as
  raw HTML (carried over from 001 FR-015a / NFR-006).
- **FR-055 (Chat ordering — per-peer only)**: Within a single peer-pair's
  RTCDataChannel, message order MUST be preserved (a property of
  RTCDataChannel's default ordered/reliable mode). Across peer-pairs,
  the MVP **does NOT require globally consistent chat ordering**: in a
  4-person room, two recipients MAY observe the same group message at
  slightly different absolute times, and the **relative order** of
  messages from different senders MAY differ between recipients. The UI
  MUST display each chat message's local-send timestamp (sender's clock)
  and local-receive timestamp (recipient's clock) so the learner can
  reason about ordering manually. The MVP MUST NOT introduce any
  cross-peer ordering protocol, vector clocks, or causal-delivery
  guarantees.

**Per-peer event log & lifecycle visibility**

- **FR-060**: The UI MUST show a human-readable, timestamped event log
  covering all pairwise events. At minimum:
  `room joined`,
  `mesh roster snapshot received` (initial roster delivery — see
  FR-012a),
  `mesh roster updated` (any subsequent presence/readiness change —
  see FR-012b),
  `peer joined`,
  `peer released` (post-admission media failure — see EC-003,
  FR-013, FR-014),
  `peer left`,
  `peer pair pairing started`,
  `offer created`, `offer received`,
  `answer created`, `answer received`,
  `ICE candidate sent`, `ICE candidate received`,
  `connection state changed` (with new state value),
  `ICE state changed` (with new state value),
  `ICE gathering state changed` (with new state value: `new` /
  `gathering` / `complete`; mandated by Constitution Principle V),
  `signaling state changed` (with new state value),
  `DataChannel opened`, `DataChannel closed`,
  `local track replaced` (camera→screen, screen→camera),
  `remote track received`, `remote media state changed`,
  `screen share started`, `screen share stopped`,
  `chat message sent` (with fan-out summary),
  `chat message received` (with sender peer ID/label and transport
  label per FR-053),
  `peer pair failed` (with reason),
  `peer pair reconnect requested` (manual reconnect-this-pair
  invoked — see FR-026, US7 AS#3),
  `peer pair fresh attempt started` (new pair-attempt identifier per
  FR-021a; replaces a prior failed attempt),
  `signaling error` (local-viewpoint signaling-socket loss — see
  EC-012, SC-005b),
  `error occurred` (with reason).
- **FR-061**: Every pairwise event-log entry MUST carry an explicit **peer
  ID or peer label** so the learner can tell which peer-pair an event
  concerns. Room-scoped events (e.g., `room joined`) MAY omit the peer ID.
- **FR-062**: The event log MUST be visible without opening browser
  developer tools (Principle V).
- **FR-063**: Every error surfaced to the user MUST also produce a
  corresponding `error occurred` entry in the event log with a meaningful
  reason and a peer ID/label when the error is peer-pair-scoped.
- **FR-064**: In addition to the event log, the UI MUST display
  at-a-glance, always-current persistent indicators for: local client
  session state, the room's roster (with each peer's `peerId`,
  `admission_index`, and presence/readiness state per FR-013),
  **per-peer** `RTCPeerConnection.connectionState`,
  `iceConnectionState`, `iceGatheringState`, and `signalingState`,
  **per-peer** remote mic / camera / screen-share state, **per-peer**
  DataChannel state, local mic / camera / screen-share state, and the
  mesh cost summary (FR-070). These indicators are distinct from, and
  complementary to, the event log; the log records transitions, the
  indicators show current values.
- **FR-065 (Partial-mesh room-level indicator)**: Whenever **at least one**
  peer-pair is in `failed` state and **at least one** other peer-pair is
  in `connected` state simultaneously, the UI MUST display a room-level
  **"partial mesh"** status (or equivalent label) that is visually
  distinguishable from both "fully connected mesh" and "whole-room
  failure". The mesh room itself MUST NOT enter a terminal failed state
  because of one (or several, but not all) failed peer-pairs; the
  application MUST keep healthy peer-pairs active and surface the
  partial degradation as a recoverable, per-peer condition. This
  guarantees the learner can never mistake a single failed peer-pair for
  a dead mesh room (Principle V applied at the mesh level).

**Mesh cost summary**

- **FR-070**: The UI MUST display a **mesh cost summary** panel, updated
  live, that shows from the local participant's perspective:
  - **local peer count** — the number of remote participants currently
    in the room as known to this client; equals `N − 1` where `N` is
    the roster size including the local participant;
  - **local RTCPeerConnections count** — equals `N − 1` in the happy
    path (one per remote peer);
  - **local RTCDataChannels count** — equals `N − 1` in the happy
    path (one per peer-pair; created by the offerer per FR-050);
  - **outgoing media senders count** — exactly **`2 × (N − 1)`** in
    the happy path: one audio `RTCRtpSender` plus one video
    `RTCRtpSender` per remote peer. Switching the outgoing video
    source between camera and screen MUST be implemented via
    `RTCRtpSender.replaceTrack` (FR-040), which **does not change**
    the sender count. The MVP MUST NOT use `addTransceiver` (or any
    equivalent mechanism) to add a second video sender for screen
    share; the cost-summary invariant depends on the
    single-outgoing-video-slot rule (FR-040);
  - **peer-pairs connected / failed / pending** breakdown.
- **FR-071**: The cost summary MUST make the O(N²) shape observable: as
  participants join, the local counts MUST grow in proportion to `N−1`
  (per local participant). The room-wide peer-pair total of `N×(N−1)/2`
  MUST be derivable from the per-participant summaries (e.g., shown as a
  computed total, or visible by reading any one participant's count and
  the roster size).

**Leaving & cleanup**

- **FR-080**: A participant MUST be able to leave the mesh room explicitly.
- **FR-081**: Leaving MUST stop all local media tracks (camera, microphone,
  screen share if active), close every RTCPeerConnection and
  RTCDataChannel the local participant holds, and notify every remote peer
  via the signaling server.
- **FR-082**: Each remaining participant MUST receive notification of the
  leave and clean up only the peer-pair to the leaver, leaving every other
  peer-pair untouched. The leaver's roster entry MUST be removed from each
  remaining participant's roster.
- **FR-083**: After cleanup of the local session, the UI MUST return to a
  predictable starting state from which the user can join another (or the
  same) mesh room or switch to 1:1 mode.

**Signaling contract (per constitution)**

- **FR-090**: Every signaling message exchanged for mesh mode MUST conform
  to a documented signaling contract entry — including (at minimum) a
  peer-pair identifier or sender/recipient peer-ID label on every
  pairwise message (offer / answer / ICE / media-state / leave / chat
  via signaling). The contract document is a plan-phase artifact; this
  feature requires that every mesh-specific client↔server message type be
  represented in that contract, and that mesh additions to the contract be
  **additive** so the 001 contract remains valid (FR-002).
- **FR-091**: The signaling server MUST only coordinate peers and relay
  signaling messages. It MUST NOT relay audio, video, or screen-share
  media payloads. In the final MVP, it MUST NOT relay group chat payloads
  (FR-053).

### Non-Functional Requirements

- **NFR-001 (Secure context)**: Any deployment on a non-`localhost` origin
  MUST use HTTPS for the application and WSS (or equivalent secure
  transport) for signaling. `localhost` development is exempt per browser
  secure-context rules (same as 001 NFR-001).
- **NFR-002 (No hardcoded secrets)**: TURN credentials, STUN URLs, and any
  other configurable values MUST be externalized; no secrets may be
  committed to the repo or embedded in the client bundle (same as 001
  NFR-002).
- **NFR-003 (Observability)**: WebRTC lifecycle events and signaling events
  MUST be emitted both to the in-UI per-peer event log (FR-060) and to
  browser-console structured logs. Raw SDP and raw ICE candidate strings
  MAY be exposed in a dev-mode debug view but MUST NOT be required for the
  learner to understand the concept. **TURN credentials and any other
  secrets MUST NEVER be logged** (same as 001 NFR-003).
- **NFR-004 (Simplicity)**: The MVP MUST NOT introduce SFU, MCU, simulcast,
  E2EE Insertable Streams, recording, file transfer, plugin systems, or
  generic transport abstractions with one implementation.
- **NFR-005 (Honest security claims)**: The application MUST NOT claim or
  imply end-to-end security properties beyond those provided by the
  browser's built-in WebRTC DTLS/SRTP (same as 001 NFR-005).
- **NFR-006 (Safe rendering)**: All user-provided strings — including room
  IDs, chat messages, peer labels, and any error/event payload text
  displayed in the UI — MUST be rendered as text and MUST NOT be injected
  as raw HTML (same as 001 NFR-006).
- **NFR-007 (Scaling honesty)**: The mesh mode MUST NOT attempt to hide its
  O(N²) cost from the learner. The cost summary (FR-070, FR-071) is the
  principal NFR enforcement mechanism: the application's own UI tells the
  learner why mesh stops scaling.
- **NFR-008 (Metrics are learning indicators only)**: The mesh cost summary
  (FR-070, FR-071) and the per-peer indicators (FR-013, FR-023, FR-033,
  FR-064) are **learning indicators**, not production-monitoring
  telemetry. They are not designed for alerting, longitudinal
  aggregation, dashboarding, SLA tracking, or external observability
  pipelines. The MVP MUST NOT emit any of these signals to an external
  monitoring system, time-series database, or third-party telemetry
  service. The Non-Goals section reinforces this boundary.

### Key Entities

- **Mesh Room (server-side)**: A named container identified by a
  user-entered room ID. A Mesh Room has up to **four reserved participant
  slots**. Slot occupancy and per-participant call-readiness are separate
  concepts (carried over from 001):
  - **Slot occupancy** — drives admission (`0..4 reserved`); a 5th joiner
    is rejected with `join_rejected_room_full` regardless of
    call-readiness.
  - **Per-participant call-readiness** — `joined` (admitted into a slot,
    not yet media-ready) → `media-ready` (local media acquired,
    eligible for pairing). A participant in `joined` whose media
    acquisition fails transitions on a side-exit to `released`
    (terminal, pre-pairing; no peer-pair teardown — see FR-013,
    FR-014, EC-003). Once two or more participants are `media-ready`,
    **each peer-pair has its own pairing state** (`connecting`,
    `connected`, `failed`); the room itself does NOT have a single
    "paired" state in mesh.
- **Participant**: A single browser session associated with a Mesh Room
  slot. Has a **Participant State** progressing through `joining` →
  `joined` → `media-ready` → `in-room` → `leaving` / `left` / `failed`,
  with a side-exit `joined` → `released` for post-admission media
  acquisition failures (mirrors 001's `participant_released_media_failed`;
  see FR-013, FR-014, EC-003). Has a **Local Media State** (mic on/off,
  camera on/off, screen share on/off). Each Participant carries a
  server-assigned `admission_index` — a stable, monotonically-increasing
  integer issued at admission time and broadcast as part of the roster
  (FR-012a, FR-012b) — used by FR-022 to deterministically pick the
  offerer for every peer-pair this Participant is part of. When
  in-room, each Participant additionally tracks, **per remote peer**,
  the remote's media state (received via FR-032 signaling) and that
  peer-pair's lifecycle (FR-023).
- **Peer-Pair**: The unordered pair `{participantA, participantB}` for
  which a single RTCPeerConnection and a single RTCDataChannel are
  established. A 4-person mesh room has exactly **6 peer-pairs**. Each
  Peer-Pair carries `connectionState`, `iceConnectionState`,
  `iceGatheringState`, `signalingState`, DataChannel state, and a
  per-pair event log entry stream.
- **Mesh Cost Snapshot**: A live summary, computed from this client's
  perspective, of `localPeerCount`, `localRTCPeerConnectionCount`,
  `localRTCDataChannelCount`, `outgoingMediaSenderCount`, and
  `connected / failed / pending` peer-pair counts. Rendered as the cost
  summary panel (FR-070).
- **Signaling Message (mesh-aware)**: A typed, versioned message
  conforming to the signaling contract (FR-090). For mesh, every
  pairwise offer / answer / ICE / media-state / leave / chat-via-signaling
  message MUST identify the peer-pair (via sender + recipient peer IDs or
  a peer-pair ID) so multiplexing across the mesh is unambiguous.
- **Peer-Pair Event Log Entry**: A timestamped, human-readable record of
  one lifecycle event scoped to a specific peer-pair from the local
  client's perspective. Attributes: timestamp, peer-pair identifier (peer
  ID or label), event type, direction (local / remote / system),
  reason/payload summary.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001 (Four-browser mesh call)**: Four browser windows on the same
  machine or local network, each with camera and microphone permission
  granted, can establish a full mesh call in the same mesh room on the
  first try with no manual configuration beyond entering the room ID. All
  6 peer-pairs reach `connected` in the happy path.
- **SC-002 (Mode coexistence with 001)**: A learner can run a 1:1 call in
  001 mode and a 4-way call in mesh mode within the same running
  application build, and **all 001 acceptance criteria continue to pass**
  while the mesh acceptance criteria pass.
- **SC-003 (Time-to-connected for mesh)**: On a typical local-development
  setup (multiple browsers on one machine, `localhost` signaling, default
  STUN), the time between a participant becoming media-ready and that
  participant's tile reaching `connected` for **every** existing remote
  peer is under **10 seconds** in the happy path. Time spent at the
  browser's permission prompt is excluded.
- **SC-004 (Fifth-peer rejection)**: A 5th attempt to join a 4-person mesh
  room is rejected and surfaces a clear message within **2 seconds**,
  without disturbing any of the 6 in-progress peer-pairs.
- **SC-005a (Remote-session-ended — remaining peers' viewpoint)**: When
  a remote participant's session ends without a graceful leave —
  whether by closing the browser tab, network loss, or signaling-socket
  drop on that peer — every **remaining** participant's UI MUST
  surface the gone peer's transition to `left` within **10 seconds**
  in the local-development environment. Only that peer's tile and
  roster entry are removed (per FR-014); the remaining peer-pairs (those
  not involving the gone peer) MUST remain in their actual states. This
  scenario is from the **viewpoint of peers whose own signaling socket
  is healthy**.
- **SC-005b (Local signaling loss — local viewpoint)**: When the **local**
  participant's WebSocket signaling connection drops while their P2P
  peer-pairs are otherwise healthy, the local UI MUST surface a clear
  `signaling-error` state within **5 seconds** and record a
  `signaling error` event-log entry (FR-060). Already-established
  peer-pairs (RTCPeerConnection in `connected`) MAY continue carrying
  media and DataChannel traffic until they fail on their own; if they
  do fail, EC-004 / FR-025 per-peer failure handling applies. The MVP
  MUST NOT auto-reconnect signaling; manual leave/rejoin is the
  recovery (see EC-012). From the **remote** participants' viewpoint,
  this client losing signaling is observed as SC-005a (they see this
  client as `left` within 10 s once the server detects the dropped
  socket).
- **SC-006 (DataChannel fan-out visibility)**: A learner sending a group
  chat message in a 4-person room can read, in the local UI, that the
  message was sent over **3 DataChannels** (one per remote peer), with a
  per-peer indicator of which peers received the message.
- **SC-007 (Per-peer failure isolation)**: When a single peer-pair fails
  (ICE failure or transport drop), the failure is visible only on the
  affected remote tile and in the cost summary's `failed` count; **no**
  other peer-pair is torn down or marked failed by the application as a
  side effect.
- **SC-008 (O(N²) observability)**: A learner who joins a mesh room in
  steps (alone → 2 → 3 → 4 participants) can read directly from the cost
  summary that the local RTCPeerConnection count grows as `N − 1` per
  participant, the **local outgoing media-sender count grows as
  `2 × (N − 1)`** per participant (one audio + one video sender per
  remote peer), the local RTCDataChannel count grows as `N − 1` per
  participant, and the room-wide peer-pair total grows as `N × (N−1) / 2`.
  Specifically, at N = 4 the local PC count = 3, the local sender
  count = **6**, the local DataChannel count = 3, and the total
  peer-pair count = 6.
- **SC-009 (Concurrent screen share)**: Two participants can screen-share
  at the same time, every other participant sees both screens (one per
  remote tile, replacing each sharer's camera output), and the application
  does not prompt or auto-stop either share.
- **SC-010 (Learning-outcome coverage)**: A reviewer walking through
  the running mesh mode and its per-peer event log + cost summary can
  point to at least one observable moment for **each** of the
  mesh-specific learning outcomes **L13–L18** (§"Mesh-specific
  learning outcomes"), AND can point to live per-peer indicators for
  **all four** Constitution-Principle-V lifecycle states
  (`connectionState`, `iceConnectionState`, `iceGatheringState`,
  `signalingState`) on at least one remote peer during the walkthrough.
  Coverage of 001's L1–L12 is not measured here — those are preserved
  through the running 001 mode and verified by SC-002.

## Assumptions

- **001 codepath untouched (behavioral freeze, not implementation freeze)**:
  The 001 freeze that this feature respects is **behavioral**: all 001
  functional requirements, acceptance scenarios, success criteria,
  signaling-contract semantics, room model, UI behavior, and
  constitution-mapping MUST be preserved without modification. Any
  mesh-mode signaling message types that share an envelope with 001
  messages MUST extend the contract **additively** (no breaking edits
  to the 001 contract entries). Implementation-shell changes that
  preserve **all** 001 behavior — extracting shared utilities into a
  common module, adopting a mode router, file-organization moves, or
  TypeScript-level refactors — ARE permitted and are NOT within the
  scope of the §Non-Goals "No removal or rewrite of the 001 1:1
  codepath." That Non-Goal forbids behavioral regressions and
  out-and-out replacement of 001, NOT non-breaking refactors that
  keep 001's externally-observable behavior identical.
- **Mesh-mode selection mechanism**: The way a participant enters mesh
  mode (separate route, in-app mode toggle, mode argument on `join_room`,
  or a distinct WebSocket endpoint) is a plan-level decision. The spec
  only requires that 1:1 and mesh modes are separable and concurrently
  runnable in the same build (FR-001..FR-003).
- **Room ID namespace separation**: 1:1 rooms and mesh rooms occupy
  logically separate namespaces (or the join request specifies the mode),
  so a 1:1 room "demo" and a mesh room "demo" do not collide. The exact
  mechanism (prefix, mode field on join, separate endpoint) is a plan
  choice.
- **Two-phase join carries over**: Joining a mesh room follows the same
  two-phase model as 001 (admit into the `joined` state, acquire local
  media, transition to `media-ready`, only then start pairwise
  negotiation). The reasoning is identical: media-acquisition errors
  should surface before any signaling negotiation begins.
- **Deterministic offerer per peer-pair**: For each peer-pair, exactly one
  participant is the offerer for that pair. The rule is **`lower
  admission_index = offerer; higher admission_index = answerer`**, where
  `admission_index` is a stable, monotonically-increasing integer issued
  by the signaling server at admission time and broadcast to every
  participant via the roster. The rule is applied **per peer-pair, not
  per room**, and is the per-pair generalization of 001 FR-010a (in 001,
  the first admitted of two participants is the offerer): 1:1 is the
  N=2 case of this rule, mesh is the same rule applied to every
  unordered peer-pair `{P_i, P_j}` in the room. Glare is eliminated by
  construction. The recommended pair-identity / role-assignment
  invariant (to be encoded in the signaling contract during planning):
  `pairId = sorted(admission_index_i, admission_index_j); offerer =
  peer with lower admission_index; answerer = peer with higher
  admission_index; only offerer may send offer for that pair; only
  answerer may send answer for that pair`.
- **Peer identity**: Each participant has a server-assigned, room-scoped
  peer ID that is stable for the duration of their session, plus a
  monotonically-increasing `admission_index` (also server-assigned and
  stable for the session) used for the deterministic offerer rule
  (FR-022). Optional human-readable display labels are out of scope for
  MVP and are documented as such; acceptance scenarios that name peers
  ("Alice", "Bob") MAY be tested by mapping opaque server-assigned IDs
  to those names manually in the test harness.
- **Capacity = 4 (LOCKED)**: Mesh capacity is fixed at four participants
  in MVP. Configurable capacity is explicitly out of scope unless the
  plan tags it as optional, justified work.
- **No persistent chat history**: Group chat messages are ephemeral and
  only delivered to currently-connected peers (via their open
  DataChannels). A peer who joins later does NOT receive prior messages,
  and the application MUST NOT persist or replay chat.
- **No automatic reconnect / no ICE restart proper**: The MVP does
  NOT attempt automatic reconnect of any kind, and does NOT implement
  ICE restart on an existing RTCPeerConnection. A failed peer-pair
  MAY be recovered via the **manual reconnect-this-pair affordance
  (FR-026)**, which creates a fresh RTCPeerConnection (and a new
  pair-attempt identifier per FR-021a) for that pair only — this is
  NOT an ICE restart, it is a fresh pairing. Whole-room
  auto-reconnect, signaling auto-reconnect, full-mesh reconnect, and
  ICE restart proper all remain out of scope. A dropped signaling
  connection or a page refresh still requires manual leave/rejoin in
  MVP.
- **Hardware**: Each participant has a working camera and microphone. No
  audio-only or video-only fallback is required for MVP.
- **Browser support**: Modern Chromium-based browsers are the primary
  target. Firefox and Safari behavior is documented where it diverges
  (e.g., `getDisplayMedia` prompts, codec defaults).
- **Network**: Default STUN suffices for the intended local-machine /
  local-network test scenarios; TURN is the documented fallback for
  restrictive-NAT scenarios but TURN provisioning is not in scope for
  this feature.
- **Trust**: Same as 001 — MVP users are trusted; no authentication or
  authorization is provided or required.

## Non-Goals *(mandatory — constitution G-5)*

The following are explicitly **out of scope** for this feature and MUST
NOT be introduced into the mesh MVP codepath. Each is consistent with
constitution G-5 (1:1 MVP boundary): this feature is the deliberate,
separately-scoped mesh extension; it does NOT pull additional scope along
with it. Any future work addressing items below MUST be in a separate
feature spec.

- **No SFU (Selective Forwarding Unit) or MCU.** Mesh is the **subject**
  of this feature, not the destination.
- **No server-side media forwarding.** Signaling-only server, identical
  to 001.
- **No simulcast / SVC.**
- **No custom codec selection or codec preferences.** Browser default
  codec negotiation applies; the MVP MUST NOT introduce a
  codec-selection UI, signaling fields carrying codec preferences, or
  `RTCRtpSender.setCodecPreferences` /
  `RTCRtpTransceiver.setCodecPreferences` calls. Browser-divergent
  codec defaults (Chromium / Firefox / Safari) are documented in
  §Assumptions but are not configurable from the application.
- **No E2EE Insertable Streams** beyond browser-provided WebRTC DTLS/SRTP
  defaults.
- **No call recording or media archiving.**
- **No file transfer over DataChannel.**
- **No automatic ICE restart, no ICE restart proper, no automatic
  full-mesh reconnect, no automatic signaling reconnect.** Manual
  per-pair reconnect (FR-026) IS in scope but creates a fresh
  RTCPeerConnection — it is **not** an ICE restart on an existing PC.
- **No support for more than 4 participants in MVP.**
- **No room ownership, authentication, authorization, or moderation.**
- **No invite links, QR codes, or other room-discovery UX** unless a
  later planning iteration explicitly marks an item as optional,
  justified work.
- **No persistent chat history or chat backfill on join.**
- **No mobile native applications.**
- **No internationalization / localization beyond English strings.**
- **No production monitoring, alerting, or metrics stack.** The mesh cost
  summary and per-peer indicators are **learning indicators only**, not
  telemetry (NFR-008); no metrics are emitted to external systems.
- **No deployment automation beyond local Docker-based development.**
  Cloud deploys, managed TURN provisioning, and production packaging are
  out of scope unless the plan tags a specific item as optional,
  justified work (consistent with 001).
- **No removal or rewrite of the 001 1:1 codepath.** The mesh
  implementation MUST live alongside 001, not replace it.
- **No room-level single-sharer mutex** for screen share. Multiple
  concurrent sharers are explicitly allowed (FR-041).
- **No `screen_share_busy` (or equivalent) error code** in the
  signaling or chat contract. The application MUST NOT introduce any
  room-level "current sharer" concept, busy-flag, or reservation;
  concurrent sharers (FR-041) are first-class behavior, not an
  exception path. WebRTC has no native room-level "screen share"
  concept (§Mesh-specific learning outcomes → L16).
