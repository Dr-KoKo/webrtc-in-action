# Feature Specification: 1:1 WebRTC Learning Call

**Feature Branch**: `001-webrtc-1to1-call`
**Created**: 2026-04-19
**Status**: Draft
**Input**: User description: "Build a browser-based 1:1 real-time communication application for learning WebRTC fundamentals. Feature name: '1:1 WebRTC Learning Call'."

## Purpose & Learning Intent *(mandatory for this project)*

This feature is the MVP of the `webrtc-lab` learning project. It is **not**
intended to become a production video conferencing platform. Its purpose is to
let a developer understand WebRTC end-to-end by building a minimal but realistic
1:1 application that **exposes the full connection lifecycle** rather than
hiding it behind abstractions.

Every user story below is designed to make a specific WebRTC concept observable.
The event log (US5) is therefore a first-class feature, not an accessory.

### Learning outcomes the feature MUST make explicit

The running application MUST let a learner directly observe and reason about:

- why signaling is needed,
- how offer/answer exchange works,
- what SDP represents at a high level,
- why ICE candidates are exchanged,
- what STUN is used for,
- when TURN becomes necessary,
- the difference between the signaling path and the media path,
- how local media tracks become remote media tracks,
- how muting differs from stopping or replacing tracks,
- how screen sharing affects tracks and negotiation,
- what a DataChannel is and when it is useful,
- what happens when a peer disconnects unexpectedly.

## Clarifications

### Session 2026-04-19

The following decisions were locked before planning. Each is integrated into the
relevant requirement, acceptance scenario, edge case, or assumption elsewhere in
this document; this section is the canonical record of the decision itself.

- Q: Is there a waiting queue in the MVP when a room is full? →
  A: **No.** A third joiner is rejected immediately with a `room_full`-class
  error; there is no queue, no auto-retry, and no later-promoted slot.
- Q: When is local media acquired relative to joining and negotiation? →
  A: **Local media (camera + microphone) is acquired after the user clicks
  "Join" and before the offer is created.** Permission errors therefore
  surface before any signaling negotiation begins and before the peer is
  told a call is starting.
- Q: What transport should text chat use in the final MVP? →
  A: **RTCDataChannel is the preferred final-MVP transport** because it
  directly demonstrates peer-to-peer data transport (a required learning
  outcome). A signaling-relayed chat MAY be used as an interim milestone
  while DataChannel work is in progress, but the final MVP MUST be
  DataChannel unless the plan documents a strong, explicit reason otherwise.
- Q: How does the outgoing video track change when screen sharing starts
  and stops? →
  A: **Starting screen share replaces the outgoing video track with the
  screen track (via track replacement or renegotiation — whichever the
  plan selects, the mechanism MUST be observable in the event log).
  Stopping screen share (whether via the app button OR the browser's
  native "Stop sharing" control) returns the outgoing video track to the
  camera if the camera is available; if the camera is off or absent, the
  remote video reverts to the camera-off indicator.**
- Q: What state indicators must the UI surface (beyond the event log)? →
  A: **The UI MUST display persistent, at-a-glance indicators for:**
  room state, peer presence state, local media state (mic / camera /
  screen share), remote media state, `RTCPeerConnection.connectionState`,
  `iceConnectionState`, `signalingState`, screen sharing state, and
  chat-channel state (when the DataChannel path is used). These indicators
  are in addition to — not a replacement for — the event log (FR-020).
- Q: Is offer collision (glare) a real failure mode for this MVP? →
  A: **No, by construction.** Deterministic offerer selection (above) makes
  simultaneous offers impossible in the happy path. If the implementation
  ever detects two offers in flight for the same session, it MUST log an
  `error occurred` entry identifying "offer collision" and treat it as a
  protocol-level bug, not a routine recoverable state.
- Q: What deployment automation is in scope? →
  A: **Only local Docker-based development** is in scope. Any cloud
  deployment, CI-managed deploy, TURN provisioning, or production
  packaging is out of scope for MVP unless the plan explicitly marks a
  specific item as optional work-with-justification.

### Session 2026-04-19 (review pass)

A pre-plan review surfaced ambiguities and contradictions that would have
destabilized the signaling contract. Each was locked as follows:

- Q: How are "joined the room" and "local media ready" sequenced? →
  A: **Two-phase join.** (1) Client sends `join_room`; (2) server admits
  the participant into a `pending-media` state (slot reserved, but not
  yet "paired"); (3) client acquires local camera + microphone; (4) on
  success, client emits `media_ready`; (5) room transitions to `paired`
  **only** when both admitted participants are media-ready; (6) offerer/
  answerer role is assigned at that transition; (7) if media acquisition
  fails, the server releases that participant's slot and the other peer
  remains in `waiting`. (See FR-010c.)
- Q: For screen sharing, is the outgoing video **replaced** or **added
  alongside** the camera? →
  A: **Replaced (single outgoing video slot).** The MVP uses exactly one
  outgoing video track per peer. Starting screen share replaces the
  camera track with the screen track. The plan MAY choose the mechanism
  (`RTCRtpSender.replaceTrack` vs renegotiation) but MUST NOT send camera
  and screen as two separate remote video tracks. (See FR-017.)
- Q: Does media always flow peer-to-peer directly? →
  A: **No — peer-to-peer direct OR TURN relay.** Media flows over the
  WebRTC media transport, either directly between peers or via a TURN
  relay when NAT traversal requires it. Media MUST NEVER flow through the
  application signaling server. This is consistent with the TURN learning
  outcome. (See FR-011.)
- Q: Does each peer's event log show the same events? →
  A: **No — each log is per-client perspective.** Alice logs
  `offer created`, Bob logs `offer received`, etc. The two logs are not
  identical by construction. The lifecycle is observable across the
  combined logs of both peers. (See US5 Independent Test.)
- Q: Is mic / camera / screen-share state inferred on the remote side, or
  explicitly signaled? →
  A: **Explicitly signaled.** Media-state changes are sent as a dedicated
  signaling message so the remote UI renders state deliberately rather
  than guessing from packet flow. (See FR-014a.)
- Q: How are SDP and ICE concepts surfaced for the learner? →
  A: **Via a learning-inspector summary in the UI/event log** showing SDP
  type, m-sections, ICE candidate types (host / srflx / prflx / relay),
  relay presence, and whether TURN appears to be configured. Raw SDP is
  allowed in dev-mode debug logs but MUST NOT be required to understand
  the concept. (See FR-030.)
- Q: What chat-ordering guarantee does the MVP make? →
  A: **Per-sender ordering + ordered display by local arrival time.** No
  global total order is guaranteed across simultaneous bidirectional
  sends. (See US3 Independent Test + Scenario 2.)
- Q: What is the time bound for detecting an ungraceful disconnect? →
  A: **Within 10 seconds** in the local-development environment (see
  SC-009). This permits a simple heartbeat without over-specifying.
- Q: What happens after an ICE failure? →
  A: **Enter a terminal `failed` state with a manual Leave/Rejoin
  affordance.** MVP MUST NOT attempt ICE restart or any automatic
  reconnect. (See Edge Cases.)
- Q: What are the validation rules for room IDs and chat messages? →
  A: **Room ID:** trimmed, case-sensitive, 1–64 chars, printable ASCII
  letters / digits / hyphen / underscore / dot only. **Chat:** trimmed,
  non-empty, ≤500 chars, rendered as text (never as HTML).
  (See Assumptions + FR-015a + NFR-006.)

### Session 2026-04-19 (review pass 2)

A second review exposed that adding two-phase join in review pass 1 made the
previous 3-state room enum insufficient and left three secondary holes.
These were locked as follows:

- Q: Can a 3-state room enum (`empty` / `waiting` / `paired`) represent
  two-phase join correctly? →
  A: **No.** Room now separates **slot occupancy** (drives admission:
  0/1/2 reserved) from **call-readiness** (`empty` /
  `waiting_for_media` / `waiting_for_peer` / `paired`). A third joiner
  is rejected by slot occupancy regardless of call-readiness.
  (See Key Entities.)
- Q: Is the offerer the "already-waiting" peer or the "first admitted"
  peer? →
  A: **First admitted** participant in the current pairing attempt.
  This is stable under two-phase join even if the second-admitted peer
  becomes `media_ready` first. Role assignment is sent only once the
  room reaches `paired`. (See FR-010a — rule was rewritten.)
- Q: How does the server learn that a client's local media acquisition
  failed? →
  A: **Client MUST send an explicit media-failure signal.** The server
  then releases the slot and sends
  `participant_released_media_failed` to the failed client. This is
  distinct from `join_rejected_*` (pre-admission rejections).
  (See FR-010d + renamed Join Result.)
- Q: Does the existing participant see a peer that is still
  `pending-media`? →
  A: **Yes — `pending-media` is a visible remote state.** The existing
  peer sees the remote transition absent → pending-media → ready (or
  released). This makes two-phase join observable, which aligns with
  the project's learning purpose. (See FR-022b.)
- Q: Where does SC-002's 5-second window start? →
  A: **At the moment the second participant reports `media_ready`.**
  Time spent at the browser permission prompt is excluded. The metric
  measures signaling + ICE + negotiation latency, not human reaction
  time. (See SC-002.)
- Q: What is the observable event-log contract for US5 Acceptance
  Scenario 1? →
  A: Events split into **Base lifecycle** (always produced during
  join → connect → leave) and **Conditional lifecycle** (produced only
  when the corresponding action occurs). US5 AC-1 no longer requires
  screen-share or toggle entries to appear without the actions being
  performed. (See US5 Acceptance Scenario 1.)
- Q: How does a peer-departure recovery differ from a local connection
  failure? →
  A: **Peer departure → return to waiting**; **local connection
  failure (ICE / signaling) → terminal `failed` + manual
  Leave/Rejoin.** Codified in FR-005 and Edge Cases.
- Q: Is room-ID validation client-only, server-only, or both? →
  A: **Both — client SHOULD validate for UX; server MUST validate
  authoritatively.** (See Room ID assumption.)

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Join a room and hold a 1:1 audio/video call (Priority: P1)

Two participants open the application in separate browsers (or separate
devices), enter the same room ID, grant camera/microphone permission, see each
other's video and hear each other's audio, and can end the call cleanly.

**Why this priority**: This is the MVP. Without it the project does not exist
and no WebRTC concept can be demonstrated. All other stories layer on top of
this working base.

**Independent Test**: Open two browser windows pointing at the app on the same
machine, enter the same room ID in both, accept camera/mic prompts in both, and
confirm each side sees and hears the other. Close one tab and confirm the other
returns to a waiting state.

**Acceptance Scenarios**:

1. **Given** no one is in room "demo", **When** Alice enters room ID "demo" and
   clicks Join, **Then** the app acquires Alice's camera and microphone, shows
   her local video preview, and the UI enters the "waiting for peer" state.
2. **Given** Alice is waiting in room "demo" (already admitted and
   media-ready), **When** Bob enters room ID "demo" and clicks Join,
   **Then** Bob is admitted into `pending-media`, Bob acquires camera and
   microphone and reports `media_ready`, the room reaches `paired`
   call-readiness, the signaling server assigns Alice (the **first
   admitted** participant) the **offerer** role and Bob (the second
   admitted participant) the **answerer** role, the offer/answer exchange
   completes, and both Alice and Bob see each other's remote video and
   hear each other's audio within a bounded time (see SC-002).
3. **Given** Alice and Bob are connected in room "demo", **When** Carol tries
   to enter room ID "demo", **Then** Carol is rejected with a clear,
   user-visible `room_full` error (no waiting queue, no auto-retry), and
   Alice and Bob's call is unaffected.
4. **Given** Alice and Bob are connected, **When** Bob clicks "Leave",
   **Then** Alice is notified that Bob left, Alice returns to the waiting
   state, and Bob's local media tracks are stopped and his peer connection is
   closed.
5. **Given** Alice is waiting alone in room "demo", **When** Alice clicks
   "Leave", **Then** Alice's local media stops, the room becomes empty, and
   a new peer joining "demo" sees no existing occupants.
6. **Given** Alice is waiting in room "demo" and is media-ready, **When**
   Bob clicks Join and denies camera/microphone permission in the browser
   prompt, **Then** Bob is first admitted (Alice briefly sees the remote
   peer transition from `absent` to `pending-media`), Bob's client sends
   a media-failure signal to the server, the server releases Bob's slot
   and delivers `participant_released_media_failed` to Bob, Alice's UI
   returns to `waiting_for_peer` with an event-log entry recording the
   pending-peer release, **no offer/answer negotiation was attempted**,
   and Bob is offered a retry action where the browser allows it.
7. **Given** Alice has a reserved slot (media-ready or pending-media) and
   Bob has a reserved slot but Bob is still `pending-media`, **When**
   Carol tries to join the same room, **Then** Carol is rejected with
   `join_rejected_room_full` because room capacity is based on
   **reserved slots** (two of two reserved), **not** on call-readiness.
   Alice's and Bob's reserved slots are unaffected.

---

### User Story 2 — Control local microphone and camera during a call (Priority: P2)

A participant in an active call can mute/unmute their microphone and turn
their camera on/off. The local UI reflects the current state immediately, and
the remote peer can tell that the state changed.

**Why this priority**: Media controls are a standard user expectation and are
also a key learning vehicle for the distinction between **muting** a track,
**stopping** a track, and **replacing** a track (learning outcome).

**Independent Test**: With a 1:1 call established (US1), toggle mute and
camera on one side and verify the other side sees/hears the change, and that
the local UI updates immediately.

**Acceptance Scenarios**:

1. **Given** Alice and Bob are in an active call, **When** Alice mutes her
   microphone, **Then** Alice's local UI shows a muted indicator and Bob stops
   receiving Alice's audio.
2. **Given** Alice's microphone is muted, **When** Alice unmutes,
   **Then** Alice's UI shows an unmuted indicator and Bob resumes receiving
   her audio without requiring renegotiation.
3. **Given** Alice and Bob are in an active call, **When** Alice turns her
   camera off, **Then** Alice's local preview reflects that video is off and
   Bob's view of Alice's video clearly indicates video is off (e.g., last
   frame frozen, placeholder, or blank — the spec requires a visible change,
   the exact visual is an implementation choice).
4. **Given** Alice's camera is off, **When** Alice turns her camera back on,
   **Then** both Alice's local preview and Bob's view of Alice show live
   video again.

---

### User Story 3 — Exchange text chat during a call (Priority: P2)

Two connected peers can exchange short text messages during the call.

**Why this priority**: Chat is the learning vehicle for **DataChannel** and
for making the difference between application signaling and peer-to-peer data
transport tangible (learning outcome).

**Independent Test**: With a 1:1 call established, type and send messages
from each side and confirm messages are delivered, attributed to the correct
sender, and displayed in **per-sender order**. The MVP does not require a
globally consistent total order across messages sent simultaneously by both
peers.

**Acceptance Scenarios**:

1. **Given** Alice and Bob are connected, **When** Alice sends "hello",
   **Then** Bob sees "hello" attributed to Alice in his chat view.
2. **Given** Alice and Bob are exchanging chat, **When** messages are sent
   from both sides, **Then** each side displays messages in per-sender
   order (messages from the same sender appear in send order), ordered by
   local arrival time for the interleaving of the two senders, with sender
   attribution. A globally consistent total order is NOT required.
3. **Given** Bob leaves the room, **When** Alice attempts to send a chat
   message, **Then** the UI prevents the send or surfaces a clear "no peer"
   error rather than silently dropping the message.

**Learning-goal requirement**: **RTCDataChannel is the preferred final-MVP
transport** because it directly demonstrates peer-to-peer data transport.
The plan MAY schedule a signaling-relayed chat as an interim milestone, but
the final MVP MUST use DataChannel unless the plan documents a strong,
explicit reason to deviate. Whichever transport is active at a given moment,
the UI or logs MUST make it observable whether a chat message traveled over
the signaling path or the peer-to-peer data path.

---

### User Story 4 — Share the screen during a call (Priority: P3)

A connected participant can start sharing their screen, the remote peer sees
the shared screen, and the sharer can stop sharing either from the app UI or
from the browser's own screen-share control, with correct UI cleanup on both
sides.

**Why this priority**: Screen sharing is the learning vehicle for
**outgoing video track replacement** (and optional renegotiation) and for
handling **browser-originated media events** (learning outcome). The MVP
uses a single outgoing video slot per peer; screen sharing swaps the
camera track for the screen track, not "adds a second track".

**Independent Test**: With a 1:1 call established, click "Share screen",
select a screen/window in the browser prompt, confirm the remote peer sees
the shared content, then stop sharing — once via the app button, once via the
browser's built-in "Stop sharing" control — and confirm the UI updates
correctly in both cases.

**Acceptance Scenarios**:

1. **Given** Alice and Bob are connected, **When** Alice starts screen sharing
   and picks a window, **Then** Alice's single outgoing video track is
   **replaced** by the screen track (camera track is swapped out, not sent
   alongside) — the **track-replacement event (and any renegotiation it
   triggers) MUST appear in the event log on both sides** — Bob sees
   Alice's selected screen content, and the app UI on both sides clearly
   indicates that screen share is active.
2. **Given** Alice is screen sharing, **When** Alice clicks "Stop sharing"
   in the app, **Then** screen share ends, Bob stops seeing the screen
   content, and Alice's outgoing video track reverts to the camera (if her
   camera is on and available); the corresponding track swap MUST appear in
   the event log. If Alice's camera is off or absent, the remote video
   reverts to the camera-off indicator.
3. **Given** Alice is screen sharing, **When** Alice clicks the browser's
   native "Stop sharing" control, **Then** the app detects the end-of-share
   event, performs the same track-revert behavior as scenario 2, and
   updates both Alice's and Bob's UI and event log to reflect that screen
   sharing has ended.
4. **Given** Alice attempts to screen share, **When** Alice cancels the
   browser picker, **Then** the call continues unchanged and a "screen share
   cancelled" entry appears in the event log.

---

### User Story 5 — Observe the full WebRTC lifecycle via the event log (Priority: P1)

From the moment a participant joins a room until they leave, the application
surfaces a readable, ordered event log of signaling and peer-connection
lifecycle events **in the UI**, without requiring the learner to open browser
devtools.

**Why this priority**: Per the project constitution (Principle V), WebRTC
lifecycle visibility is non-negotiable. Without it the application fails its
purpose. This is P1 alongside US1 — the MVP is not "two people can talk"; the
MVP is "two people can talk **and the learner can see how**".

**Independent Test**: Join a room in one browser, join the same room in a
second browser, then leave from one side. Confirm that **each side's event
log shows the ordered lifecycle events relevant to that side** (e.g., the
offerer logs `offer created` while the answerer logs `offer received`),
with timestamps, without needing devtools. The two sides' logs are **not
expected to be identical**; together, the combined logs across both peers
MUST expose the full offer/answer, ICE, media, chat, screen-share, and
cleanup lifecycle.

**Acceptance Scenarios**:

1. **Given** a fresh session, **When** two users complete a **base
   connection lifecycle** (join → connect → leave), **Then** each
   client's event log displays, in order and with timestamps, the events
   from the **Base lifecycle events** group below **that are relevant to
   that client's perspective** (e.g., the offerer shows `offer created`
   and `answer received`; the answerer shows `offer received` and
   `answer created`). Across both clients' combined logs, every event
   type in the Base lifecycle events group MUST appear at least once.

   **Base lifecycle events** (always produced during a normal join →
   connect → leave session):
   - `room joined`
   - `peer joined`
   - `peer left`
   - `offer created`
   - `offer received`
   - `answer created`
   - `answer received`
   - `ICE candidate sent`
   - `ICE candidate received`
   - `local track added`
   - `remote track received`
   - `connection state changed` (with new state value)
   - `ICE state changed` (with new state value)
   - `signaling state changed` (with new state value)
   - `cleanup completed`

   **Conditional lifecycle events** (produced only when the
   corresponding action or condition occurs; each MUST appear in the log
   on the affected side(s) when it does):
   - `media toggled` (mic/camera, on/off) — only when a user toggles
     mic or camera
   - `screen share started` / `screen share stopped` — only during a
     screen-sharing session
   - `chat message sent` / `chat message received` — only when a chat
     message is exchanged; each entry MUST indicate whether the
     message used the **signaling path** or the **peer-to-peer
     DataChannel path** (see FR-016)
   - `media readiness reported` — when a client sends `media_ready`
   - `pending peer released` — when a pending-media peer leaves or
     fails before becoming ready
   - `error occurred` (with reason) — only when an error condition is
     encountered

   Concretely: a user who runs the full learning-path session
   (join → connect → toggle microphone → toggle camera → send chat
   message → start screen share → stop screen share → leave) MUST
   observe, in the combined logs, every entry from both groups above.
2. **Given** an event log with many entries, **When** the user scrolls and
   reads, **Then** each entry is human-readable (not raw JSON) and the
   ordering reflects the actual sequence of events.
3. **Given** an error occurs (e.g., permission denied, ICE failure), **When**
   the learner inspects the event log, **Then** a corresponding `error
   occurred` entry is present with a reason string meaningful enough to guide
   diagnosis.

---

### Edge Cases

The following cases MUST be handled explicitly. Each must be observable in
the UI and/or event log; silent failure is not acceptable.

- **EC-001 — User joins an empty room** → UI enters "waiting for peer"
  state with a shareable room ID visible.
- **EC-002 — User joins a room that already has one peer waiting** →
  both users transition into the connecting flow (offer/answer) and
  ultimately into the connected state.
- **EC-003 — Third user attempts to join an occupied 1:1 room** → the
  third user's join is rejected with a clear, user-visible message; the
  existing call is not disturbed.
- **EC-004 — User denies camera or microphone permission** → UI shows a
  clear error explaining that media access was denied, lists what the
  learner can do (e.g., grant permission in browser settings and retry),
  and offers a retry action where the browser permits it.
- **EC-005 — User has no camera or microphone hardware** → UI shows a
  clear error identifying which device is missing; call cannot proceed
  in full A/V mode. The spec does not require audio-only fallback for
  MVP (see Non-Goals).
- **EC-006 — WebRTC connection fails due to network restrictions
  (symmetric NAT, firewall)** → both clients MUST stop the active peer
  connection, enter a terminal `failed` state, show "connection failed"
  with an ICE-failure entry in the event log, and surface a manual
  **Leave / Rejoin** affordance. The MVP MUST NOT attempt automatic ICE
  restart or signaling reconnect.
- **EC-007 — ICE gathering completes without a viable connection** →
  treated as connection failure (as EC-006), with a log entry
  distinguishing "no viable candidates" from other failure modes. Same
  terminal `failed` behavior applies.
- **EC-008 — Remote peer refreshes the page** → local side detects the
  peer drop, shows "peer left" in UI and log, and returns to waiting
  state; the refreshed peer re-joins as a fresh participant.
- **EC-009 — Remote peer closes the browser without a graceful leave**
  → local side detects the drop (via connection state change or
  signaling disconnect within a bounded time — see SC-009) and
  transitions identically to an explicit leave.
- **EC-010 — WebSocket signaling disconnects during negotiation** → UI
  surfaces a signaling-error state; MVP does not auto-reconnect (see
  Non-Goals), but the user can leave and rejoin cleanly.
- **EC-011 — User stops screen sharing via the browser's native
  control** → application detects the end-of-share event and updates UI
  and log (revert behavior per FR-019).
- **EC-012 — User leaves during offer/answer negotiation** →
  in-progress negotiation is cancelled cleanly on both sides, no zombie
  peer connection is left, and the other peer returns to waiting state.
- **EC-013 — Offer collision (glare)** → MUST NOT occur under the
  deterministic offerer rule (the first-admitted participant is the
  unique offerer, with role assignment delivered only at `paired`). If
  the implementation ever observes two offers in flight for the same
  session, it MUST surface an `error occurred` log entry tagged "offer
  collision" and treat it as a protocol-level bug rather than a
  recoverable state.

## Requirements *(mandatory)*

### Functional Requirements

**Room & presence**

- **FR-001**: The system MUST allow a user to enter an arbitrary room ID and
  join the room identified by that ID.
- **FR-002**: The system MUST limit each room to exactly two participants.
- **FR-003**: The system MUST reject any attempt to join an already-full room
  with a clear, user-visible error message.
- **FR-004**: The system MUST show each user's current session state
  via the persistent state indicators (FR-022a), including at minimum:
  `idle`, `joining`, `waiting` (covering `waiting_for_media` /
  `waiting_for_peer`), `connecting`, `connected`, `leaving`, and
  `failed`.
- **FR-005**: The system MUST notify a user when their remote peer
  leaves (graceful or ungraceful) and return that user to the
  appropriate waiting state (`waiting_for_peer` if the local participant
  is still media-ready). **A remote-peer departure** (graceful leave,
  tab close, refresh, detected drop) is distinct from **a local
  connection failure** (ICE failure, signaling failure during
  negotiation): the former returns the remaining participant to
  waiting; the latter places the remaining participant in the terminal
  `failed` state with a manual Leave/Rejoin affordance (see Edge
  Cases).

**Local media**

- **FR-006**: The system MUST request camera and microphone access before
  establishing a call.
- **FR-007**: The system MUST display a local video preview of the
  acquired camera stream.
- **FR-008**: The system MUST show a clear, user-visible error when camera
  or microphone access is denied or unavailable.
- **FR-009**: The system MUST provide a retry affordance for media
  acquisition where the browser permits retry.

**Peer connection (WebRTC)**

- **FR-010**: When two peers are present in the same room, the system MUST
  establish a direct WebRTC peer connection between them via offer/answer
  exchange and ICE candidate exchange.
- **FR-010a (Deterministic offerer by admission order)**: The signaling
  server MUST assign roles by **admission order within the current
  pairing attempt**: the **first admitted** participant is the
  **offerer**, the **second admitted** participant is the **answerer**.
  The server MUST send role assignment **only after both admitted
  participants have reported `media_ready`** (i.e., only when the room
  reaches `paired` call-readiness). Clients MUST NOT initiate an offer
  unless they have received the offerer role from the server. If the
  first admitted participant is released (media failure, leave) before
  pairing, the next pairing attempt re-evaluates admission order from
  the currently reserved slots. This eliminates offer collision by
  construction and remains stable under two-phase join regardless of
  the order in which the two peers become media-ready.
- **FR-010b (Media-acquisition timing)**: Each client MUST acquire its
  local camera and microphone **after** the user clicks Join and
  **before** it creates (offerer) or accepts (answerer) any SDP. Any
  permission error MUST be surfaced to the user before signaling
  negotiation begins; on permission failure the client MUST NOT send or
  process offer/answer for that join attempt.
- **FR-010c (Media readiness before pairing)**: Joining follows a
  two-phase model. (1) The client sends a join request. (2) If the room
  has capacity, the server admits the participant into a
  **`pending-media`** state — the slot is reserved (and counts toward
  room capacity for rejection purposes), but the room has NOT
  transitioned to `paired`. (3) The client acquires local media. (4) On
  success, the client sends a `media_ready` signal. (5) The server MUST
  NOT transition the room's call-readiness to `paired` and MUST NOT
  send offerer/answerer role assignment until **both** admitted
  participants have reported `media_ready`. (6) If a participant fails
  media acquisition (see FR-010d), the server MUST release that
  participant's reserved slot and MUST keep the other participant in
  `waiting_for_peer` (media-ready, no peer) or `waiting_for_media`
  (still pending-media) as appropriate; no offer/answer exchange is
  attempted for the failed participant.
- **FR-010d (Media-acquisition failure reporting)**: If local media
  acquisition fails after the client has received `join_accepted`, the
  client MUST notify the signaling server via an explicit
  **media-failure signal** before abandoning the join attempt, wherever
  the browser permits (e.g., the permission-denied promise rejection is
  caught and a message is sent). On receipt, the server MUST:
  (a) release that participant's reserved slot;
  (b) send a `participant_released_media_failed` Join Result to the
  failed client so its UI can distinguish "denied" from "initial
  rejection";
  (c) notify the remote participant **only if** the remote was already
  shown the pending peer (see FR-022b), returning that remote to the
  appropriate waiting state;
  (d) MUST NOT send offerer/answerer role assignment for a participant
  that failed media acquisition.
  A media-acquisition failure after admission is **not** an initial
  join rejection; it is a post-admission release of a reserved slot.

  **Pending-media disconnect (no signal available)**: If a
  `pending-media` participant disconnects (WebSocket close, tab close,
  browser crash) **before** sending either `media_ready` or a
  media-failure signal, the signaling server MUST release that
  participant's reserved slot via the same cleanup path as a
  pre-pairing departure. Any existing remote participant that was shown
  the pending peer (per FR-022b) MUST be returned to `waiting_for_peer`
  and MUST receive a pending-peer-release event.
- **FR-011**: Media (audio, video, screen share) MUST flow over the
  WebRTC media transport path — either **directly between peers** when
  NAT traversal permits, or **through a TURN relay** when required for
  NAT traversal. Media MUST NEVER flow through the application signaling
  server.
- **FR-012**: Once connected, each peer MUST be able to see the remote
  peer's video and hear the remote peer's audio (subject to remote media
  state per FR-013/FR-014).

**Media controls**

- **FR-013**: A user MUST be able to mute and unmute their microphone
  during an active call; the local UI MUST immediately reflect the change
  and the remote peer MUST be able to tell the audio state changed.
- **FR-014**: A user MUST be able to turn their camera on and off during
  an active call; the local UI MUST immediately reflect the change and the
  remote peer's view MUST visibly reflect that video is off/on.
- **FR-014a (Remote media state signaling)**: Whenever a participant
  changes microphone, camera, or screen-sharing state, the client MUST
  notify the remote peer via an **explicit media-state signaling
  message** so the remote UI can render the state change deliberately
  rather than inferring it from packet flow alone. The message MUST
  distinguish at minimum: mic muted/unmuted, camera on/off, screen share
  active/inactive. This is what powers the remote-media state indicators
  in FR-022a.

**Text chat**

- **FR-015**: Connected peers MUST be able to exchange short text messages
  during a call, with sender attribution and per-sender-ordered display
  on both sides. A globally consistent total order across simultaneous
  bidirectional sends is NOT required.
- **FR-015a (Chat message validation)**: Chat messages MUST be trimmed
  of leading/trailing whitespace, MUST be rejected if empty after trim,
  MUST be limited to a maximum length of **500 characters**, and MUST
  be rendered as text — never as raw HTML (see NFR-006).
- **FR-016**: The system MUST make it observable (in UI or event log)
  whether a given chat message traveled via the signaling path or the
  peer-to-peer data path, to preserve the learning goal.
- **FR-016a (DataChannel preference)**: The final MVP chat transport MUST
  be **RTCDataChannel** unless the plan documents a strong, explicit
  reason to deviate. A signaling-relayed chat MAY be used as an interim
  milestone only; any such interim implementation MUST be replaced by
  DataChannel before MVP is declared complete.

**Screen sharing**

- **FR-017**: A connected peer MUST be able to start screen sharing; the
  remote peer MUST see the shared screen content **as the sharer's single
  outgoing video**. The MVP uses exactly **one outgoing video track per
  peer**: starting screen share **replaces** the outgoing camera track
  with the screen track (it MUST NOT send camera and screen as two
  separate remote video tracks). The plan MAY implement this via
  `RTCRtpSender.replaceTrack` or via renegotiation; whichever mechanism
  is chosen MUST appear in the event log on both sides so the learner
  can observe how screen sharing affects tracks and negotiation.
- **FR-018**: The sharer MUST be able to stop screen sharing from the app
  UI. On stop, the outgoing video track MUST revert to the camera if the
  camera is available (on); if the camera is off or absent, the remote
  view MUST revert to the camera-off indicator. The revert MUST appear in
  the event log.
- **FR-019**: If screen sharing ends via the browser's native "Stop
  sharing" control, the application MUST detect this event and perform
  the same revert behavior as FR-018, with a corresponding event-log
  entry on both sides.

**Event log & lifecycle visibility**

- **FR-020**: The UI MUST show a human-readable, timestamped event log
  covering at minimum all event types listed in US5 Acceptance Scenario 1.
- **FR-021**: The event log MUST be visible without opening browser
  developer tools.
- **FR-022**: Every error surfaced to the user MUST also produce a
  corresponding `error occurred` entry in the event log with a meaningful
  reason.
- **FR-022a (Persistent state indicators)**: In addition to the event
  log (FR-020), the UI MUST display at-a-glance, always-current
  indicators for the following states, updated live as they change:
  - **local client session state**: `idle` / `joining` / `waiting` /
    `connecting` / `connected` / `leaving` / `failed`,
  - **peer presence**: remote peer `absent` / `pending-media` / `ready` /
    `left`,
  - **local media**: microphone on/off, camera on/off, screen share
    on/off,
  - **remote media** (from FR-014a signaling): remote mic on/off, remote
    camera on/off, remote screen share on/off,
  - `RTCPeerConnection.connectionState`,
  - `RTCPeerConnection.iceConnectionState`,
  - `RTCPeerConnection.signalingState`,
  - **screen-sharing state**: `idle` / `active` / `stopping`,
  - **chat-channel state** (when DataChannel is used): `connecting` /
    `open` / `closing` / `closed`.
  These indicators are distinct from, and complementary to, the event
  log; the log records transitions, the indicators show current values.
  Note: "server room occupancy state" is a separate concept (see Key
  Entities) and is not directly rendered in the UI — clients render
  their own perspective.
- **FR-022b (Remote pending-media visibility)**: When a second
  participant is admitted into a reserved slot but has not yet reported
  `media_ready`, the existing participant's UI MUST show the remote
  peer as **`pending-media`** (distinct from `absent`, `ready`, and
  `left`). If that pending participant subsequently fails media
  acquisition, disconnects, or leaves before reporting `media_ready`,
  the existing participant returns to `waiting_for_peer`, an event-log
  entry records the pending-peer release, and **no offer/answer
  exchange is started during this period**. This makes the two-phase
  join flow observable, which is part of the project's learning
  purpose.
  **Bidirectional updates**: Peer-presence updates MUST be sent to
  **both** reserved participants whenever either participant's
  readiness state changes (admitted → `pending-media` → `ready` →
  `left`/`released`). Each side renders the other's state from its own
  perspective. This means, e.g., a participant who becomes `media_ready`
  first can still observe the other as `pending-media` until the other
  catches up.

**Leaving & cleanup**

- **FR-023**: A user MUST be able to leave the room explicitly.
- **FR-024**: Leaving MUST stop all local media tracks (camera, microphone,
  screen share if active).
- **FR-025**: Leaving MUST close the peer connection and release
  chat-transport resources.
- **FR-026**: Leaving MUST notify the remote peer so they can return to the
  waiting state.
- **FR-027**: After cleanup, the UI MUST return to a predictable starting
  state from which the user can join another (or the same) room.

**Signaling contract (per constitution)**

- **FR-028**: All messages exchanged between client and signaling server
  MUST conform to a documented signaling contract (message types, required
  fields, optional fields, error cases, and contract version). The
  contract document itself is an artifact of the plan phase, but this
  feature requires that every client↔server message type be represented
  in that contract.
- **FR-029**: The signaling server MUST only coordinate peers and relay
  signaling messages. It MUST NOT relay audio, video, or screen-share
  media payloads.

**Learning inspector**

- **FR-030 (Learning inspector for SDP / ICE / STUN / TURN)**: The UI
  MUST provide a human-readable WebRTC learning summary for SDP and ICE
  events so that the learning outcomes "what SDP represents", "why ICE
  candidates are exchanged", "what STUN is used for", and "when TURN
  becomes necessary" are observable **without** requiring the learner to
  read raw SDP strings or raw candidate strings. At minimum, the UI or
  event log MUST surface:
  - SDP type: `offer` or `answer`,
  - media sections present: `audio` / `video` / `data`,
  - ICE candidate type when available: `host` / `srflx` / `prflx` /
    `relay`,
  - whether any `relay` candidate is present on the local side,
  - whether **STUN** appears to be configured (from configuration) and
    whether any server-reflexive (`srflx`) candidate was actually
    observed during gathering — the "configured but no srflx observed"
    case MUST be explicit so the learner can reason about network
    reachability to the STUN server,
  - whether **TURN** appears to be configured (from configuration) or
    unavailable.
  Raw SDP and raw candidate payloads MAY additionally be viewable in a
  dev-mode details panel or the browser console (see NFR-003), but MUST
  NOT be the only way to understand the concept.

### Non-Functional Requirements

- **NFR-001 (Secure context)**: Any deployment on a non-`localhost` origin
  MUST use HTTPS for the application and WSS (or equivalent secure
  transport) for signaling. `localhost` development is exempt per browser
  secure-context rules.
- **NFR-002 (No hardcoded secrets)**: TURN credentials, STUN URLs, and any
  other configurable values MUST be externalized; no secrets may be
  committed to the repo or embedded in the client bundle.
- **NFR-003 (Observability)**: WebRTC lifecycle events and signaling
  events MUST be emitted both to the in-UI event log (FR-020) and to
  browser-console structured logs, for parity with the constitution's
  observability principle. The in-UI event log MUST show summarized,
  human-readable details by default; raw SDP and raw ICE candidate
  strings MAY be exposed in a dev-mode debug view or in the browser
  console, but MUST NOT be required for the learner to understand the
  concept (see FR-030). **TURN credentials and any other secrets MUST
  NEVER be logged** (UI, console, or server logs).
- **NFR-004 (Simplicity)**: The MVP MUST NOT introduce plugin systems,
  generic transport abstractions with a single implementation, multi-party
  data structures, or persistence layers.
- **NFR-005 (Honest security claims)**: The application MUST NOT claim or
  imply end-to-end security properties beyond those provided by the
  browser's built-in WebRTC DTLS/SRTP. If E2EE is not implemented, the
  documentation MUST say so plainly.
- **NFR-006 (Safe rendering)**: All user-provided strings — including
  room IDs, chat messages, and any error/event payload text displayed
  in the UI — MUST be rendered as text and MUST NOT be injected as raw
  HTML. No `innerHTML`-style interpolation of user input is permitted
  anywhere in the UI layer.

### Key Entities

- **Room (server-side)**: A named container identified by a user-entered
  room ID. A Room has up to **two reserved participant slots**.
  **Capacity and call-readiness are separate concepts** (this matters
  because two-phase join means a slot can be reserved before its
  occupant is media-ready).

  **Slot occupancy** — drives admission decisions:
  - `0 reserved` → capacity for two more,
  - `1 reserved` → capacity for one more,
  - `2 reserved` → full for admission; any third join attempt is
    **rejected with `join_rejected_room_full`**, even if one or both
    reserved participants are still `pending-media`.

  **Call-readiness state** — derived from participant readiness within
  the reserved slots:
  - `empty` — no reserved participants,
  - `waiting_for_media` — at least one reserved participant has not yet
    reported `media_ready`,
  - `waiting_for_peer` — exactly one participant is media-ready and
    the room still has capacity for one more,
  - `paired` — exactly two participants are media-ready; offerer/
    answerer role assignment may now be sent.

  **Rejection is not a room state.** A join attempt that cannot be
  admitted produces a per-attempt **Join Result** delivered only to the
  attempting client (see below); the existing room's occupancy and
  call-readiness are unaffected.

- **Join Result** (client-visible outcome of a single join attempt or
  admission lifecycle event):
  - `join_accepted` — client is admitted into a `pending-media` slot,
  - `join_rejected_room_full` — room already has two reserved slots,
  - `join_rejected_invalid_room` — room ID fails validation,
  - `participant_released_media_failed` — a previously-admitted client
    reported media-acquisition failure and its reserved slot was
    released. Note: this is **not an initial join rejection** — the
    client was admitted, then its slot was released after local media
    acquisition failed.
- **Participant**: A single browser session associated with a Room slot.
  Has a **Participant State** progressing through `joining` →
  `pending-media` → `ready` → `in-call` → `leaving`/`failed`, and a
  **Local Media State** (mic on/off, camera on/off, screen share
  on/off). When paired, each Participant also carries a view of the
  **Remote Participant's** media state received via FR-014a signaling.
- **Signaling Message**: A typed, versioned message conforming to the
  signaling contract (FR-028). Carries join/leave, room-state updates,
  role assignment, media readiness, offer/answer SDP, ICE candidates,
  media-state notifications, chat (if signaling-path chat is used), and
  errors.
- **Peer Connection**: The WebRTC session between the two Participants.
  Has `connectionState`, `iceConnectionState`, `iceGatheringState`, and
  `signalingState` — all surfaced in the event log (FR-020) and in the
  persistent state indicators (FR-022a).
- **Event Log Entry**: A timestamped, human-readable record of one
  lifecycle event **from the local client's perspective**. Attributes:
  timestamp, event type, direction (local / remote / system),
  reason/payload summary. Logs on the two peers are NOT expected to be
  identical (see US5 Independent Test).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001 (Two-browser call)**: Two browsers on the same local network,
  both with camera and microphone permission granted, can establish a 1:1
  audio and video call in the same room on the first try with no manual
  configuration beyond entering the room ID.
- **SC-002 (Time-to-connected)**: On a typical local-development setup
  (two browsers on the same machine, `localhost` signaling, default
  STUN), the time between **the room reaching `paired` call-readiness**
  — i.e., both admitted participants have reported `media_ready` and
  role assignment may be sent — and both peers seeing remote video is
  under **5 seconds** in the happy path. Time spent at the browser's
  camera/microphone permission prompt is explicitly excluded, because
  the `paired` transition by definition requires both peers to be
  media-ready. This metric therefore reflects signaling + ICE +
  negotiation latency, not human reaction time on permission dialogs.
- **SC-003 (Third-peer rejection)**: A third attempt to join an occupied
  room is rejected and surfaces a clear message within 2 seconds,
  without disturbing the in-progress call.
- **SC-004 (Lifecycle visibility)**: A learner who runs one full
  happy-path session (join → connect → toggle mic → toggle camera → chat →
  screen share → leave) can read the full ordered lifecycle in the in-UI
  event log without opening browser devtools.
- **SC-005 (Clean cleanup)**: After either participant leaves, no camera
  or microphone "in use" indicator remains active on the leaver's device,
  and the remaining participant's UI returns to the waiting state within
  5 seconds.
- **SC-006 (Permission-denied clarity)**: When camera or microphone
  permission is denied, the user sees, within 2 seconds, a message that
  names which permission was denied and describes how to retry.
- **SC-007 (Screen-share correctness)**: A screen share started from the
  app and stopped via the browser's native "Stop sharing" control results
  in the remote peer's screen-share view ending within 2 seconds, and
  both UIs reflecting the stopped state.
- **SC-008 (Learning-outcome coverage)**: A reviewer walking through the
  running application and its event log can point to at least one
  observable moment for **each** of the twelve learning outcomes listed
  in "Purpose & Learning Intent".
- **SC-009 (Ungraceful-disconnect detection)**: When a remote peer
  closes the browser tab or loses the signaling connection without a
  graceful leave, the remaining peer's UI MUST surface the peer-left or
  disconnected state within **10 seconds** in the local-development
  environment.

## Assumptions

- **Trust**: MVP users are trusted; no authentication or authorization is
  provided or required.
- **Room ID format**: Room IDs are **trimmed before validation**,
  **case-sensitive**, **1–64 characters**, and limited to **printable
  ASCII letters, digits, hyphen (`-`), underscore (`_`), and dot (`.`)**.
  Any character outside this set produces a `join_rejected_invalid_room`
  result. Collisions (two pairs picking the same ID) remain the users'
  responsibility.
  **Validation locations**: the client SHOULD validate for immediate
  UX feedback, but the signaling server MUST enforce the same rules
  and its validation is authoritative. A client that bypasses
  client-side validation MUST still be rejected by the server.
- **Room ID sharing**: Room IDs are shared manually between participants
  (copy/paste, messaging app, verbal). No invite links or discovery
  mechanism is provided.
- **Offerer role (LOCKED by Clarifications 2026-04-19 review pass 2, see
  FR-010a)**: Roles are assigned by **admission order within the current
  pairing attempt** — the **first admitted** participant is the offerer,
  the **second admitted** participant is the answerer. Roles are
  communicated by the signaling server **only when the room reaches
  `paired` call-readiness** (both peers reported `media_ready`). Clients
  never infer the role from local timing. If the first admitted peer is
  released before pairing, the next pairing attempt re-evaluates
  admission order from the currently reserved slots.
- **No waiting queue (LOCKED)**: When a room is full, the third joiner is
  rejected immediately; there is no queue, no automatic retry, and no
  mechanism that promotes a waiting joiner into a freed slot.
- **Screen-share + camera (LOCKED — single outgoing video)**: The MVP
  uses exactly **one outgoing video track per peer**. While screen
  sharing is active, the sharer's outgoing video is the screen track
  (camera track is swapped out, not sent alongside). The sharer's local
  camera preview MAY remain visible locally for feedback, but is not
  transmitted. When screen share ends, the outgoing video reverts to the
  camera (if camera is on and available). Sending camera and screen as
  two separate remote video tracks is a **non-goal** for MVP (see
  Non-Goals).
- **Chat scope**: Chat messages are ephemeral and only exchanged while
  both peers are in the room. No history is persisted, replayed, or
  visible to a peer who joins later.
- **Reconnection**: MVP does not attempt automatic reconnection. If the
  signaling connection or peer connection drops, the user is expected to
  leave and rejoin. This is deliberate — see Non-Goals.
- **Target environment**: The application is primarily used in local
  development and controlled test environments. Production deployment
  concerns (certificates, scalable TURN, monitoring) are documented but
  out of scope for MVP.
- **Browser support**: Modern Chromium-based browsers are the primary
  target. Firefox and Safari behavior are documented where they diverge
  (e.g., `getDisplayMedia` prompts, codec defaults), but MVP acceptance
  is measured on Chromium.
- **Network**: Default STUN is sufficient for the intended
  local-network / same-machine test scenarios. TURN is documented as the
  fallback for restrictive-NAT scenarios but TURN provisioning is not in
  scope for this feature.
- **Hardware**: Users have a working camera and microphone. The MVP does
  not require an audio-only or video-only fallback flow.

## Non-Goals *(mandatory — constitution G-5)*

The following are explicitly **out of scope** for this feature and MUST
NOT be introduced into the MVP codepath. Any future work addressing them
MUST be in a separate feature spec.

- No user accounts, authentication, or authorization.
- No database or persistent storage of users, rooms, sessions, media, or
  chat history.
- No multi-party calls (>2 peers in a room).
- No SFU (Selective Forwarding Unit) or MCU architecture.
- No call recording or media archiving.
- No mobile native applications (iOS / Android native builds).
- No file transfer.
- No simultaneous camera + screen as **two separate remote video
  tracks**. The MVP uses a single outgoing video slot per peer (see
  FR-017 and the screen-share assumption).
- No production monitoring, alerting, or metrics stack.
- No deployment automation beyond local Docker-based development. Cloud
  deploys, CI deploy pipelines, managed TURN provisioning, and production
  packaging are out of scope unless the plan explicitly marks a specific
  item as optional, justified work.
- No advanced reconnect algorithm (e.g., ICE restart with backoff,
  signaling auto-reconnect). A dropped connection requires a manual
  rejoin in MVP.
- No custom end-to-end encryption beyond the browser-provided WebRTC
  DTLS/SRTP defaults.
- No audio-only / video-only fallback mode when hardware is missing.
- No invite links, QR codes, or other room-discovery UX.
- No internationalization / localization beyond English strings in MVP.
- No admin, moderation, or reporting tooling.
