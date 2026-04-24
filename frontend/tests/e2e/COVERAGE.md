# E2E coverage map

Tracks which spec anchors in
`specs/001-webrtc-1to1-call/spec.md` have Playwright coverage, which
are deferred, and why. **Definition of done** for any future scenario
PR: update this file.

Status key:
- ✅ **covered** — at least one spec file asserts the behaviour.
- ⚠ **partial** — some of the spec's required observables are
  asserted, but not all.
- 🕓 **deferred** — intentionally out of scope this round; reason
  and unlocking condition recorded below.
- 🚧 **phase-N** — not yet reachable because the app doesn't
  implement the underlying behaviour until Phase N.

---

## User Stories

| Anchor | Summary | Status | Scenario | Note |
|---|---|---|---|---|
| US1 AS1 | Alice joins empty room → waiting-for-peer | ✅ | `scenario-6-solo-waiting.spec.ts` | Also satisfies EC-001. |
| US1 AS2 | Alice + Bob connect, both see/hear each other | 🚧 phase-7/8 | — | Needs RTCPeerConnection + offer/answer/ICE + remote tracks. |
| US1 AS3 | Carol rejected from full room | ✅ | `scenario-2-room-full.spec.ts` | Also satisfies EC-003. |
| US1 AS4 | Bob leaves mid-call → Alice returns to waiting | 🕓 deferred | — | **Phase 12 has shipped** (`frontend/src/webrtc/cleanup.tsx` Path B + `frontend/src/state/session.ts` `PEER_LEFT` action). Unit coverage is complete: `tests/unit/cleanup.spec.ts > Path B — remote peer_left` asserts PC/DC teardown, ICE-buffer clear, `connecting\|connected → waiting-for-peer`, WS stays open, local tracks stay live (the "local camera off when remote hangs up" regression guard), and a `cleanup_completed` event-log row with `code=remote_peer_left`. Server-side coverage: `signaling/tests/protocol_flow_test.go > TestInCallDisconnectEmitsPeerLeft` and `TestInCallLeaveEmitsPeerLeft` pin the §C.6 classifier. E2E is blocked on the same "drive two peers to `connected`" scaffolding that blocks US1 AS2 / SC-001 / EC-002; unblocks with that shared helper. Future scenario shape: both peers connected via fake-device, Alice's tab closes, assert Bob's session indicator flips to `waiting-for-peer` with a `cleanup_completed` row of `code=remote_peer_left`. |
| US1 AS5 | Alice leaves alone → room empties | ⚠ partial | `scenario-4-leave-from-media-error.spec.ts` | **Phase 12 has shipped** the Leave path from any state via the centralized `useCleanup().leaveSession()` orchestrator (`frontend/src/webrtc/cleanup.tsx` Path A). Unit coverage: three `tests/unit/cleanup.spec.ts > Path A` tests pin the §C.5 step order (tracks first, then DC/PC, then `leave_room`, then WS close, then reducer reset), assert `cleanup_completed` event-log `code=local_leave`, and — critically — lock the screen-share-before-pc-close ordering so the controller's final `replaceTrack(null)` lands on the live sender. E2E remains partial because `scenario-4` exercises only `media-error`→`idle`; the richer `waiting-for-peer`/`connecting`/`connected`→`idle` transitions await the shared connected-state e2e helper. |
| US1 AS6 | Bob denies permission → server releases → Alice returns to waiting | ✅ | `scenario-3-media-failure-retry.spec.ts` (B's side) + `scenario-7-remote-sees-pending-release.spec.ts` (A's side) | Both perspectives asserted. |
| US1 AS7 | Carol rejected when A+B both reserved regardless of media-readiness | ✅ | `scenario-2-room-full.spec.ts` | Slots reserved on `join_accepted`; `room_joined` event fires before `media_ready_sent`, so the third join is rejected while both predecessors may still be pending-media. |
| US2 (mute/cam) | Mic/camera toggle during call | 🕓 deferred | — | **Phase 10 has shipped** (`frontend/src/components/MediaControls.tsx`, server relay in `signaling/internal/signaling/handler.go`). Unit coverage is complete: `tests/unit/media-controls.spec.ts` pins the no-renegotiation invariant (signalingState stays `stable`, createOffer never called); `tests/contract/dispatcher.spec.ts` pins inbound `media_state` → slice + event-log routing and the peer-left clearing; `signaling/tests/protocol_flow_test.go` pins server-side relay, full-triplet validation, and pending-media rejection. E2E is blocked on the same "drive two peers to `connected`" scaffolding that blocks US1 AS2 / SC-001 / EC-002; unblocks with that shared helper. Future scenario shape: both peers connected via fake-device, fire the four-click sequence from `docs/manual-tests/two-browser-test.md` T-13, assert the remote peer's `media_state` event-log rows appear in order. |
| US3 (chat) | Text chat during call | 🚧 phase-9 | — | Needs DataChannel. |
| US4 (screen share) | Share screen, remote peer sees it | 🕓 deferred | — | **Phase 11 has shipped** (`frontend/src/webrtc/screen-share.ts`, `frontend/src/components/ScreenShareButton.tsx`; mounted in `AppShell`). Unit coverage is complete: `tests/unit/screen-share.spec.ts` pins the single-outgoing-video-slot invariant across all five scenarios — start() calls `replaceTrack(screenTrack)` exactly once with `createOffer` never invoked and `signalingState` staying `"stable"`; `stop("app")` reverts to the camera track (or `replaceTrack(null)` when camera is off — no `removeTrack`) with zero `createOffer` calls; the browser-native `onended` path routes through the same `stop` code with `source: "browser"`; picker cancellation (`NotAllowedError`) is a no-op + single `screen_share_cancelled` log entry; `media_state` emissions are full triplets on both start and stop (§3.11). E2E is blocked on the same "drive two peers to `connected`" scaffolding that blocks US1 AS2 / SC-001 / EC-002 (+ the Chromium `--auto-select-desktop-capture-source` / `--use-fake-ui-for-media-stream` flags for headless screen capture); unblocks with that shared helper. Future scenario shape: both peers connected via fake-device, fire the T-14 sequence from `docs/manual-tests/two-browser-test.md` (start, app-stop, browser-stop, picker-cancel), assert the remote peer's `media_state` event-log rows carry `screen=active` → `screen=inactive` in order and local log carries matching `screen_share_started` / `track_replaced` / `screen_share_stopped`. |
| US5 AS1 | Base lifecycle events visible in each client's log | ⚠ partial | `scenario-5-base-lifecycle.spec.ts` | **Phase-6 subset** covered (transport_changed, join_room_sent, room_joined, media_acquire_started, media_ready_sent, peer_presence_changed × 2). Offer/answer/ICE/connection-state/cleanup events land with Phase 7+; extend `expectBaseLifecycleEvents` in `fixtures.ts` at that time. |
| US5 AS2 | Entries are human-readable, ordered | ⚠ partial | (implicit in all scenarios) | Every scenario asserts `summary` text (human-readable). Strict ordering is intentionally not asserted per plan (StrictMode-era guardrail; presence-based). |
| US5 AS3 | Errors surface in log with a useful reason | ✅ | `scenario-2-room-full.spec.ts`, `scenario-3-media-failure-retry.spec.ts` | `error_occurred` + `participant_released` rows asserted. |

---

## Edge Cases

| Anchor | Summary | Status | Scenario | Note |
|---|---|---|---|---|
| EC-001 | Empty-room join → waiting | ✅ | `scenario-6-solo-waiting.spec.ts` | Mirrors US1 AS1. |
| EC-002 | Second peer joins → connecting flow | 🚧 phase-7 | — | Needs offer/answer. |
| EC-003 | Third peer rejected | ✅ | `scenario-2-room-full.spec.ts` | |
| contract §3.3 / Assumptions (Room ID format) | Invalid room ID → client-side regex rejects pre-emptively (`JoinForm.tsx:109`); server would return `join_rejected_invalid_room` | 🕓 deferred | — | **Phase-6 reachable.** Deferred this round to keep initial expansion tight. No dedicated EC in the spec — anchored to the signaling-protocol contract (§3.3) and the Assumptions block's Room ID format rules (`spec.md:931-935`). Future scenario (~20 lines): fill `#room-id-input` with `bad room!`, submit, assert the `role=alert` inline text + an `error_occurred` event with code `invalid_room_id`. No state change. |
| EC-004 / SC-006 | User denies camera or microphone permission → clear error + retry | ⚠ partial | `scenario-3-media-failure-retry.spec.ts` | Retry affordance + alert text asserted. SC-006's "names which permission was denied" is a product-copy gap (UI says "Camera or microphone unavailable" without distinguishing); treat as a product change, not an e2e gap. |
| EC-005 | No camera/mic hardware | 🕓 deferred | — | **Phase-6 reachable** with a new `?media=failNotFound` mode in the test-entry (throws `NotFoundError`). Deferred because the underlying UI copy does not distinguish device-not-found from permission-denied today; fixing the copy is a product change, and the e2e scenario would just repeat EC-004's shape until that copy ships. |
| EC-006 | WebRTC connection fails (symmetric NAT / ICE) | 🕓 deferred | — | **Phase 12 has shipped** (`frontend/src/webrtc/peer-connection-provider.tsx` onConnectionStateChange=`failed` → `CONNECTION_FAILED` → `SessionState=failed`, with teardown that keeps local tracks live until the user clicks Leave/Rejoin on the `FailurePanel`). Unit coverage: `tests/unit/cleanup.spec.ts > TestIceFailureEntersFailed` pins the reducer → UI transition; `Path C` tests pin Leave/Rejoin semantics. Server cannot observe `RTCPeerConnection.connectionState`, so the classifier half is client-only; the server's disconnect classifier is covered by T086. E2E is blocked on the same connected-state scaffolding as US1 AS2. Future scenario: both peers `connected`, firewall-block UDP on one peer's context, assert terminal `failed` + Leave/Rejoin buttons visible within SC-006's bound. |
| EC-007 | ICE gathering exhausts without viable pair | 🕓 deferred | — | Same shape as EC-006; both branches of §B.1 `connecting|connected → failed` are unified in Phase 12's `CONNECTION_FAILED` reducer action. Unit-level distinction between "no-viable-candidates" and "ICE connection failed" lives in the event-log narration (`error_occurred` summary text); e2e blocked on connected-state scaffolding. |
| EC-008 | Remote peer refreshes | 🕓 deferred | — | **Phase-6 reachable** via `pageB.reload()` or `ctxB.close()`; the server broadcasts `peer_presence_changed` with reason `disconnect` which the dispatcher logs. Phase 12 adds a structured `cleanup_completed` row with `code=remote_peer_left` that e2e can target instead of the raw presence event. Deferred because SC-009 allows up to 10 s, which meaningfully slows the suite. Future scenario: both peers reach waiting-for-peer, reload pageB, assert pageA's log contains a `cleanup_completed` row with `code=remote_peer_left` within 10 s. |
| EC-009 | Remote peer closes browser | 🕓 deferred | — | Same shape and deferral as EC-008; use `ctxB.close()` instead of reload. **Server coverage has shipped** — `signaling/tests/protocol_flow_test.go > TestWSPongTimeoutReleasesSlot` proves the Pong-timeout branch of Phase 12's `classifyDeparture` emits `peer_presence_changed(left, disconnect)` + `peer_left(disconnect)` for in-call peers within the SC-009 budget (at fast-heartbeat test harness). SC-009 budget still applies to e2e. |
| EC-010 | WS disconnects during negotiation | 🕓 deferred | — | **Phase 12 has shipped** the signaling-disconnect branching (`frontend/src/webrtc/cleanup.tsx` `onTransportChange` handler). Unit coverage: two `tests/unit/cleanup.spec.ts > T084` tests pin the split — transport error while session ∈ `{joining, pending-media, waiting-for-peer, connecting}` → `SessionState=failed`; transport error while `connected` → `SignalingTransportState=error` + teachable-moment warning, `SessionState` stays `connected`, media keeps flowing P2P. E2E blocked on the connected-state scaffolding; the negotiation-phase half is reachable today via a deliberately-wrong `VITE_SIGNALING_URL`. |
| EC-011 | User stops screen share via browser native control | 🕓 deferred (→ US4) | — | Covered at unit level by `tests/unit/screen-share.spec.ts` ("onended triggers stop('browser') with matching revert"). E2E blocked on the same scaffolding as US4. |
| EC-012 | User leaves during negotiation | 🕓 deferred | — | **Phase 12 has shipped** — `signaling/tests/protocol_flow_test.go > TestLeaveDuringNegotiation` pins the server-side clean teardown: offerer sends an offer, answerer receives it, offerer hangs up before the answer arrives, and the remaining peer observes `peer_presence_changed(left, graceful_leave)` + `peer_left(graceful_leave)` with no zombie PC on the server. Client-side coverage lives in `tests/unit/cleanup.spec.ts > Path A` (the Leave button centralizes through `useCleanup().leaveSession()` for every non-idle state, including `connecting` mid-handshake). E2E blocked on the connected-state scaffolding. |
| EC-013 | Offer collision (glare) | 🚧 phase-7 | — | Deterministic-offerer rule makes this unreachable by design; Phase 7 needs a Go protocol-flow test only. |

---

## Success Criteria

| Anchor | Summary | Status | Scenario | Note |
|---|---|---|---|---|
| SC-001 | Two browsers can establish a 1:1 call on first try | 🚧 phase-7/8 | — | Needs PC connected state. |
| SC-002 | Time-to-connected ≤ 5 s after `paired` | 🚧 phase-7/8 | — | Needs connected-state transition with timing. |
| SC-003 | Third-peer rejection within 2 s | ✅ | `scenario-2-room-full.spec.ts` | Alert visibility wrapped in `{ timeout: 2000 }`. |
| SC-004 | Full lifecycle readable in UI | ⚠ partial | `scenario-5-base-lifecycle.spec.ts` | Phase-6 subset. Full coverage arrives with phase-7+ lifecycle events. |
| SC-005 | Clean cleanup (OS camera indicator clears in ≤ 5 s) | ⚠ partial | `tests/unit/cleanup.spec.ts` | **Phase 12 has shipped** — unit tests assert that `leaveSession()` calls `LocalMediaProvider.release()` (which stops every track) BEFORE closing the PC, and that track `readyState` flips to `"ended"` synchronously in the same microtask as the Leave click. The ≤ 5 s wall-clock bound is by construction under those assertions (a synchronous release is well under 5 s). The OS-level camera indicator itself remains on the manual checklist because Chromium fake-device never lights the indicator in CI. |
| SC-006 | Permission-denied clarity within 2 s | ⚠ partial | `scenario-3-media-failure-retry.spec.ts` | Clarity asserted ("Camera or microphone unavailable"). "Names which permission was denied" not satisfied — product-copy gap, not an e2e gap. |
| SC-007 | Screen share stop detected ≤ 2 s | 🕓 deferred (→ US4) | — | Phase 11 stop path emits `media_state(screenShare=inactive)` synchronously with the Phase 10 relay, so the remote flip is bounded by the existing signaling round-trip; the 2 s criterion is satisfied by construction. E2E waits on the same shared scaffolding as US4. |
| SC-008 | Every learning outcome observable | 🚧 phase-11 | — | Needs the full feature set in place. |
| SC-009 | Ungraceful disconnect detected ≤ 10 s | ⚠ partial | `signaling/tests/protocol_flow_test.go` | **Phase 12 has shipped** — `TestWSPongTimeoutReleasesSlot` runs with a fast-heartbeat harness (50 ms ping / 100 ms pong) and asserts `peer_presence_changed(left, disconnect)` + `peer_left(disconnect)` fire within 2 s; `TestPongTimeoutClosesWithin10s` (heartbeat_test.go) proves the same Pong-timeout path completes within the SC-009 10 s bound at production defaults (5 s ping / 5 s pong). E2E remains deferred (→ EC-008/EC-009) because the SC-009 budget slows the suite. |

---

## How to pick up a deferral

1. Find the row, note the unlocking condition.
2. If Phase-6 reachable (🕓): write a new scenario file named
   `scenario-N-<anchor>.spec.ts`. Keep the presence-based assertion
   style documented in `fixtures.ts`.
3. If Phase-7+ (🚧): wait for the corresponding phase to ship
   (check `specs/001-webrtc-1to1-call/tasks.md`). When it does,
   extend `expectBaseLifecycleEvents` for new base events in that
   phase, and add a new scenario file per acceptance scenario.
4. Flip the row's status and update the `Scenario` column.
5. Move the "Note" content into the commit message so the PR
   reviewer sees the reason the row existed.
