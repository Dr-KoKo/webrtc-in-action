# Phase 0 Research — SFU Learning Room (003)

**Branch**: `003-webrtc-sfu-room` | **Date**: 2026-05-03
**Plan**: [plan.md](./plan.md) | **Spec**: [spec.md](./spec.md)

> Scope: this document resolves only **implementation choices** that the
> spec did not pre-decide. Spec-level decisions DD-001..DD-005 (locked
> 2026-05-03 by the clarify pass) and the plan-level decision PD-001
> (leave/rejoin only) are **not** reopened here; they are restated where
> a research item depends on them.

---

## 1. Go WebRTC / RTP library choice for in-process mediafabric

### Decision

**Use Pion WebRTC v4** (`github.com/pion/webrtc/v4`) as the in-process
WebRTC stack inside `signaling/internal/modes/sfu/mediafabric/`.

Pin a single minor version in `signaling/go.mod` (target: latest
stable v4.x at the time of S6 implementation) and gate any subsequent
upgrade behind a separate spec change.

### Rationale

DD-001 = A locks the mediafabric package location in-process and
forbids both an external product-style SFU wrapper and a from-scratch
ICE/DTLS/SRTP/RTP/RTCP implementation. That leaves exactly one class of
implementation: a low-level Go WebRTC library. Within that class, Pion
is uniquely suited:

- It is **Go-native**, single-process, no CGo. Fits cleanly inside the
  existing Go signaling binary (DD-001) with no Docker Compose surface
  changes.
- It exposes `RTCPeerConnection`, `RTCRtpTransceiver`, `RTCRtpSender`,
  `RTCRtpReceiver`, `Track`, ICE/DTLS/SRTP, and RTP/RTCP at
  primitive granularity. A learner can read `mediafabric/forwarder.go`
  and trace an actual RTP packet from ingress to egress.
- It has first-class support for the operations 003 needs:
  - per-participant bidirectional `PeerConnection` (DD-002 = A);
  - sendonly + recvonly transceivers (publish + subscribe pattern);
  - `TrackLocalStaticRTP` for forwarding without re-encoding;
  - explicit `OnTrack` callbacks on ingress;
  - SDP offer/answer roles either side (server-as-answerer is the model
    used here).
- It does **not** hide the media path behind a "publish/subscribe
  product API" — there is no equivalent of LiveKit's room SDK or
  mediasoup's worker-supervised abstraction. The learner sees the
  WebRTC primitives.

### Alternatives considered

| Alternative | Rejected because |
|---|---|
| Wrap a product-style SFU (LiveKit, mediasoup, Janus, Jitsi). | DD-001 explicitly forbids hiding the media path. These products are excellent for production but they replace the learning surface with an SDK or a JSON-RPC façade; the protocol mechanics that L19..L25 ask the learner to observe are inside their black box. |
| Run a separate Pion-based Go service in Docker Compose. | Adds a second Go service and its own signaling glue without educational gain at N=4. DD-001 = A is single-binary. |
| Build ICE/DTLS/SRTP/RTP/RTCP from scratch. | Wildly out of scope (NFR-010). Would dwarf every other phase. |
| `gst-go` / GStreamer bindings. | CGo dependency, much larger surface area, indirect WebRTC primitives via plugin pipelines. Worse fit for the learning goal than Pion. |
| `webrtc-rs` (Rust port of Pion). | Rust is not the project's host language; introduces FFI for no benefit at N=4. |

### Implications captured

- `signaling/go.mod` gains a Pion v4 dependency in S6 (plan §25).
- `mediafabric/` files (S6) own all Pion imports; nothing else in the
  Go tree imports Pion. (This is a layering convention, not enforced
  by the boundary audit, but verified by code review.)
- STUN/TURN configuration travels via env vars in Docker Compose (no
  managed TURN; Non-Goals).
- No simulcast / SVC / codec selection / E2EE Insertable Streams in
  MVP (NFR-010); Pion supports these but they are not in MVP scope.

---

## 2. Browser↔SFU negotiation ownership

### Decision

**Browser owns the offer; SFU answers — for both the initial transport
and every subscriber renegotiation.**

- The browser sends `transport_offer` immediately after `media_ready`,
  with `transportAttemptId = 1`.
- The SFU answers with `transport_answer { transportAttemptId: 1 }`.
- For every subscription change the SFU sends
  `transport_renegotiation_needed { transportAttemptId: N+1, intent }`.
  The browser increments its local attempt counter, builds the next
  offer, and sends `transport_offer { transportAttemptId: N+1 }`. The
  SFU answers.
- **Every transport-negotiation message** (`transport_offer`,
  `transport_answer`, `transport_ice_candidate`,
  `transport_offer_requested`, `transport_renegotiation_needed`)
  carries `transportAttemptId`. The receiver drops messages whose
  `transportAttemptId` is less than the current attempt for the local
  SFU transport (EC-009).

### Rationale

- **Avoids glare by construction.** The SFU never creates an offer.
  Implicit "polite/impolite" peer logic from the WHATWG spec is not
  needed because there is exactly one offerer.
- **Aligns with the 002 mesh `pairEpoch` pattern.** 002 introduced a
  monotonic per-pair epoch on negotiation messages; v3 does the same
  for the single per-participant transport. A learner moving from
  002 to 003 sees the same idea (stale-message rejection) at a
  different scope.
- **Plays well with Pion's strengths.** Pion's `PeerConnection`
  cleanly answers SDP offers; producing fresh offers server-side
  would require additional state coordination for no gain.

### Alternatives considered

| Alternative | Rejected because |
|---|---|
| Server creates the initial offer; browser answers. | More state on the server side (a tracked outstanding offer per participant); does not match the natural client-driven join flow. |
| Either side may offer; resolve glare with polite/impolite role. | More complex than 003 needs; one extra state machine to learn. |
| One PC for publish + a second PC for subscribe (asymmetric WHIP-style). | DD-002 = A explicitly rejects this. Adds a second transport row, breaks the L21 "single browser↔SFU PC" learning beat. |

### Implications captured

- The v3 contract message names are inflected from this decision
  (`transport_offer_requested` is informational; the actual offer is
  always browser → server).
- `transportAttemptId` is monotonic uint64; both sides increment in
  lockstep. The server is authoritative on the value when it sends
  `transport_renegotiation_needed`; the browser uses that value as
  its next attempt.
- Media-state metadata (`media_state_update`) is **not** a
  transport-negotiation message and MUST NOT carry
  `transportAttemptId` (FR-090 (a)).

---

## 3. Transceiver strategy

### Decision

- **Initial offer carries** exactly one audio sendonly transceiver
  and exactly one video sendonly transceiver. Both are added before
  `createOffer` via `pc.addTransceiver("audio", { direction:
  "sendonly" })` and the same for video. The audio sender's track is
  the microphone track from `getUserMedia`; the video sender's track
  is the camera track. **Screen share replaces the video sender's
  track** later via `RTCRtpSender.replaceTrack` (DD-004 = A).
- **Subscriber recvonly transceivers** are added on the browser side
  in response to `transport_renegotiation_needed { intent: "add_subscription",
  subscribedTrackId, originParticipantId, kind }` from the server.
  The browser calls `pc.addTransceiver(kind, { direction: "recvonly" })`,
  records the new transceiver against the `subscribedTrackId`, and
  re-offers.
- **On subscription removal**, the matching recvonly transceiver is
  marked `direction: "inactive"` (`pc.getTransceivers()` lookup by the
  recorded `subscribedTrackId` → `transceiver.direction = "inactive"`).
  The browser re-offers if the SFU explicitly requests it via
  `transport_renegotiation_needed { intent: "remove_subscription" }`;
  otherwise the inactive transceiver simply remains and is reused if
  the SFU later attaches a different remote track via
  `subscribed_track_added` (server side: re-uses the same `mid` /
  transceiver slot).

### Rationale

- **One stable video sender** is the prerequisite for screen share
  via `replaceTrack` (DD-004 = A; FR-042). Adding screen share as a
  second sender would (a) break L20 "uplink stays at 1 copy per
  published track" and (b) require a renegotiation just to start
  sharing — both excluded by spec.
- **`recvonly` (not `sendrecv`) on subscriber transceivers** is the
  honest direction; it lets the browser drop received tracks
  cleanly without confusion about whether the browser is also
  expected to send back.
- **Reusing inactive transceivers** keeps SDP m-line counts modest
  and matches Pion's natural `mid` handling on the server side.

### Alternatives considered

| Alternative | Rejected because |
|---|---|
| Pre-allocate `N − 1` audio + `N − 1` video recvonly transceivers up front. | Adds churn to the initial offer; the precise N at offer time depends on join order and arrival. |
| Use `addTrack` (Plan B) for senders. | The unified plan (`addTransceiver`) is the modern API and gives explicit direction control; needed for `recvonly`. |
| Add a second video sender for screen share. | DD-004 = A explicitly rejects. |
| Add a new transceiver per renegotiation rather than reusing inactive. | Fine functionally but creates SDP m-line bloat over time and obscures the inspector's m-line summary. |

### Implications captured

- `frontend/src/modes/sfu/webrtc/transceivers.ts` owns the bookkeeping
  (`subscribedTrackId → mid → transceiver`).
- The learning inspector reads m-line count per `pc.localDescription`
  and renders "audio: N, video: M" from it (no raw SDP).
- Subscriber renegotiation is the single mechanism that drives
  `signalingState` excursions during normal operation (FR-025).

---

## 4. Forwarding metadata strategy

### Decision

`mediafabric/summary.go` exposes a **lifecycle / routing summary**, not
per-packet telemetry:

- Per **PublishedTrack**: kind (audio/video), current source label
  (microphone/camera/screen), inbound source/SSRC label (server-side
  redacted to participant identity, never raw SSRC hex), subscriber
  delivery count, list of subscriber peer IDs (origin label only),
  forwarding established / forwarding stopped lifecycle events.
- Per **SubscribedTrack**: origin participant ID, kind, current source
  label.
- Per **forwarding leg**: forwarding established / forwarding stopped;
  no per-packet emission.

The frontend receives these summaries via two v3 messages:

- `forwarding_summary_update` — periodic or change-driven snapshot
  for cost summary + inspector;
- `learning_inspector_update` — same payload class scoped to the
  learning inspector panel (separate from cost summary so the
  inspector can render finer-grained per-track summaries).

The "SFU media forwarded" event-log entry (FR-062) is emitted at
**lifecycle granularity**, e.g. `"SFU forwarding established: Alice
video → Bob, Carol, Dan"`. There is **no** per-packet entry.

### Rationale

- Per-RTP-packet emission would overwhelm the learner (FR-062
  explicit prohibition).
- Routing-summary granularity matches L20 / L23 / L24 directly (cost
  summary already cares about delivery count, not packets).
- DD-005 = B + EC-016 + NFR-004 forbid raw SSRC hex / raw payloads
  in the UI / event log / app logs.

### Alternatives considered

| Alternative | Rejected because |
|---|---|
| Stream RTP packet stats live to the inspector. | NFR-004 + FR-062 + UX (overwhelming). |
| Render raw SSRC hex values for forwarding identification. | DD-005 = B + EC-016. Use participant-origin labels instead. |
| Aggregate stats every 1 s with rate counters. | Closer to production telemetry than learning indicator (NFR-009). MVP keeps forwarding-summary at lifecycle/snapshot level. |

### Implications captured

- `mediafabric.Snapshot()` is cheap and called by the verb on
  state-change triggers (forwarding established/stopped, source
  switch, mute) and on a small idle cadence sufficient to keep
  panels alive.
- The frontend caches the most recent summary per track in the
  `inspector` slice; cost summary derives counts from it.

---

## 5. Media-state metadata strategy

### Decision

- `media_state_update` is the **only** carrier of mute / camera-toggle
  / video-source-switch state (FR-033).
- Scope is **participant-level or track-level**, never
  transport-attempt-scoped (FR-090 (a)).
- Required identifiers: `participantId` (always) + `publishedTrackId`
  (for publisher-side state) or `subscribedTrackId` (when a
  subscriber-side reflection is needed).
- Forbidden identifiers: `transportAttemptId` (the v3 contract
  reserves it for transport-negotiation messages and rejects it on
  metadata messages — see contract §3).
- **No renegotiation** for any media-state change. The browser flips
  `RTCRtpSender.track.enabled` (mute) or `replaceTrack` (camera-off,
  camera ↔ screen). No SDP exchange is triggered.
- Server fans out `media_state_update` to all other room participants
  (one upload, fan-out at the SFU).

### Rationale

- DD-005's "media-state vs transport" distinction is the central
  publisher/subscriber learning beat: a learner who sees mute as a
  metadata message — not a renegotiation — internalizes that the
  SFU is forwarding bytes that already carry whatever the publisher
  is sending, and the metadata only describes intent.
- Mirrors 002's `pair_media_state` semantics but at participant scope
  (no per-pair fan-out at the client; SFU does the fan-out).

### Alternatives considered

| Alternative | Rejected because |
|---|---|
| Treat mute as a publisher track-removal / track-add. | Requires renegotiation; defeats EC-007. |
| Carry `transportAttemptId` on `media_state_update` "for safety". | Conflates scopes; FR-090 (a) explicitly forbids it. |
| Client-side fan-out (each participant tells every other). | Mesh pattern; not the SFU pattern. SFU = one upload, server fans out. |

### Implications captured

- `signaling/publish_subscribe.go` server handler validates the
  payload, emits to all room peers (including the sender's confirmation),
  and never logs the value beyond a count + correlation ID.
- The frontend `webrtc/media.ts` verb sends one `media_state_update`
  per local toggle, then updates the local store (no optimistic
  echo waiting on the server fan-out for own UI).
- Tests assert: zero SDP renegotiations during a 50-cycle mute /
  unmute / camera-off / camera-on / screen / camera storm.

---

## 6. SFU unavailable simulation strategy

### Decision

Two distinct test paths:

1. **mediafabric impaired but control plane alive** —
   `mediafabric/status.go` exposes a private `SimulateImpairment()`
   hook gated behind a build tag (`//go:build sfu_test`) and an env
   var (`SFU_FAULT_INJECT=mediafabric_unavailable`). When triggered,
   `mediafabric.Status()` returns `unavailable`; the verb layer
   broadcasts `sfu_status_changed { status: "unavailable" }` on
   `/ws/sfu`. Existing forwarding may be torn down or kept; both
   produce the FR-083 (a) UI outcome.
2. **Whole signaling/control plane down** — operator runs
   `docker compose stop signaling`. Each browser's `/ws/sfu` socket
   closes; client surfaces `signaling-error` within 5 s (SC-S04b,
   FR-083 (b)). No server message reaches the clients; nothing is
   broadcast.

The two paths are visually distinguishable in the UI:

- **Case 1**: room-level "SFU unavailable" banner driven by
  `sfu_status_changed`.
- **Case 2**: per-participant local "Signaling connection lost"
  banner driven by WS-close.

### Rationale

- DD-001 = A places the media plane and signaling plane in the same
  process, so the failure-mode taxonomy is exactly these two cases.
- The build-tag-gated fault hook is the only realistic way to
  simulate (1) without taking down the process.
- The whole-process-down case (2) needs no instrumentation — it is
  the natural outcome of `docker compose stop signaling`.

### Alternatives considered

| Alternative | Rejected because |
|---|---|
| Add a runtime "fault" admin endpoint always on. | Production-shaped surface that violates Non-Goals (no admin / moderation; no production deployment automation). |
| Block ports with `iptables` to simulate impairment. | Brittle; harder to teach; same failure mode as case (2) anyway since it kills WS too. |
| Skip case (1) testing entirely. | Drops L25 and FR-083 (a) coverage. |

### Implications captured

- The fault hook lives under `signaling/internal/modes/sfu/mediafabric/`
  with a `//go:build sfu_test` build tag so it cannot ship in a
  production build. Manual quickstart §"Failure scenarios" exercises
  both cases.
- Backend test `tests/modes/sfu/sfu_status_test.go` uses the hook to
  drive case (1).
- `docker compose stop signaling` is the documented step for case (2).

---

## 7. Failure recovery scope

### Decision (PD-001, locked)

**Leave/Rejoin only.** No manual per-transport "Reconnect to SFU"
button in MVP, no automatic reconnect, no ICE restart proper, no
automatic signaling reconnect.

Trigger surfaces:

- Local "Leave SFU" button (always visible).
- Re-join the route after leaving (or after a `signaling-error` /
  transport-failed indicator).

### Rationale

- 002 mesh already teaches reconnect-this-pair via fresh PC. 003 is
  the topology learning step; folding reconnect-to-SFU into the same
  feature dilutes the topology focus.
- FR-026 + Non-Goals + NFR-010 already lock out automatic reconnect /
  ICE restart proper / autoscaling. Plan-level locking the
  manual-reconnect button keeps the recovery posture symmetric.
- Reconnect-to-SFU can be added as a follow-up feature focused on
  recovery, not on topology.

### Alternatives considered

| Alternative | Rejected because |
|---|---|
| Add a manual "Reconnect to SFU" button per local SFU transport. | Adds UI surface for a use case not aligned with L19..L25. |
| Add automatic reconnect with a backoff. | NFR-010 + FR-026 + Non-Goals. |
| Trigger ICE restart on `iceConnectionState = failed`. | Same. |

### Implications captured

- The transport-failed indicator (FR-080) shows the failure;
  recovery affordance is the always-visible "Leave SFU" button +
  the route-rejoin path. No new UI control.
- Tests assert the absence of a "Reconnect" control under
  `frontend/src/modes/sfu/components/`.

---

## 8. Notes (no decision required)

- **Heartbeat parameters.** SFU mode reuses the existing
  `internal/shared/heartbeat/` with mode-local labels (mirrors
  001/002). Default ping = 5 s, pong-timeout = 5 s; configurable via
  `PING_INTERVAL_MS` / `PONG_TIMEOUT_MS` env vars (shared with 001 /
  002 server config). Bound for ungraceful disconnect propagation:
  10 s (SC-S04).
- **Room ID validation.** Identical to 001 / 002:
  trimmed before validation, case-sensitive, 1–64 characters,
  `[A-Za-z0-9._-]`. Rejected before any media transport is
  established (FR-010, EC-013).
- **STUN/TURN configuration.** Loaded via `internal/shared/config/`
  from env vars (`STUN_URLS`, `TURN_URL`, `TURN_USERNAME`,
  `TURN_PASSWORD`); `mediafabric` and the v3 `join_accepted` payload
  use the same `IceServer` shape. Credentials never logged or
  rendered (NFR-002, NFR-004).
- **No browser-side WebRTC wrapper library.** Per NFR-007, the SFU
  frontend continues to use browser primitives directly — no new
  third-party WebRTC client library is added. `peer-connection.ts`
  and `transceivers.ts` are thin transparent helpers.
