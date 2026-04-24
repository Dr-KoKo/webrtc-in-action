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
| US1 AS4 | Bob leaves mid-call → Alice returns to waiting | 🚧 phase-7+ | — | "Mid-call" requires connected state; reducer rejects LEAVE_REQUESTED from waiting-for-peer/connecting/connected in Phase 6. |
| US1 AS5 | Alice leaves alone → room empties | ⚠ partial | `scenario-4-leave-from-media-error.spec.ts` | Only covers Leave from `media-error`. Leave from `waiting-for-peer` is Phase-7 reducer work. |
| US1 AS6 | Bob denies permission → server releases → Alice returns to waiting | ✅ | `scenario-3-media-failure-retry.spec.ts` (B's side) + `scenario-7-remote-sees-pending-release.spec.ts` (A's side) | Both perspectives asserted. |
| US1 AS7 | Carol rejected when A+B both reserved regardless of media-readiness | ✅ | `scenario-2-room-full.spec.ts` | Slots reserved on `join_accepted`; `room_joined` event fires before `media_ready_sent`, so the third join is rejected while both predecessors may still be pending-media. |
| US2 (mute/cam) | Mic/camera toggle during call | 🚧 phase-10 | — | Needs media controls implementation + connected peers. |
| US3 (chat) | Text chat during call | 🚧 phase-9 | — | Needs DataChannel. |
| US4 (screen share) | Share screen, remote peer sees it | 🚧 phase-11 | — | Needs replaceTrack + DataChannel + connected call. |
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
| EC-004 | Invalid room ID → client rejects | 🕓 deferred | — | **Phase-6 reachable.** Deferred this round to keep initial expansion tight. Future scenario (~20 lines): fill `#room-id-input` with `bad room!`, submit, assert the `role=alert` inline text + an `error_occurred` event with code `invalid_room_id`. No state change. |
| EC-004 / SC-006 | Permission denied → clear error + retry | ⚠ partial | `scenario-3-media-failure-retry.spec.ts` | Retry affordance + alert text asserted. SC-006's "names which permission was denied" is a product-copy gap (UI says "Camera or microphone unavailable" without distinguishing); treat as a product change, not an e2e gap. |
| EC-005 | No camera/mic hardware | 🕓 deferred | — | **Phase-6 reachable** with a new `?media=failNotFound` mode in the test-entry (throws `NotFoundError`). Deferred because the underlying UI copy does not distinguish device-not-found from permission-denied today; fixing the copy is a product change, and the e2e scenario would just repeat EC-004's shape until that copy ships. |
| EC-006 | WebRTC connection fails (symmetric NAT / ICE) | 🚧 phase-7/8 | — | Needs ICE failure path. |
| EC-007 | ICE gathering exhausts without viable pair | 🚧 phase-8 | — | Needs ICE gathering to exist. |
| EC-008 | Remote peer refreshes | 🕓 deferred | — | **Phase-6 reachable** via `pageB.reload()` or `ctxB.close()`; the server broadcasts `peer_presence_changed` with reason `disconnect` which the dispatcher logs. Deferred because SC-009 allows up to 10 s, which meaningfully slows the suite. Future scenario: both peers reach waiting-for-peer, reload pageB, assert pageA's log contains a `peer_presence_changed` row with reason `disconnect` within 10 s. |
| EC-009 | Remote peer closes browser | 🕓 deferred | — | Same shape and deferral as EC-008; use `ctxB.close()` instead of reload. SC-009 budget applies. |
| EC-010 | WS disconnects during negotiation | 🚧 phase-7 | — | "Negotiation" requires offer/answer. Phase-6 has a subset (`JoinForm.runJoinFlow` connect-failure path) but no scenario — would need a fake signaling URL. |
| EC-011 | User stops screen share via browser native control | 🚧 phase-11 | — | |
| EC-012 | User leaves during negotiation | 🚧 phase-7/12 | — | |
| EC-013 | Offer collision (glare) | 🚧 phase-7 | — | Deterministic-offerer rule makes this unreachable by design; Phase 7 needs a Go protocol-flow test only. |

---

## Success Criteria

| Anchor | Summary | Status | Scenario | Note |
|---|---|---|---|---|
| SC-001 | Two browsers can establish a 1:1 call on first try | 🚧 phase-7/8 | — | Needs PC connected state. |
| SC-002 | Time-to-connected ≤ 5 s after `paired` | 🚧 phase-7/8 | — | Needs connected-state transition with timing. |
| SC-003 | Third-peer rejection within 2 s | ✅ | `scenario-2-room-full.spec.ts` | Alert visibility wrapped in `{ timeout: 2000 }`. |
| SC-004 | Full lifecycle readable in UI | ⚠ partial | `scenario-5-base-lifecycle.spec.ts` | Phase-6 subset. Full coverage arrives with phase-7+ lifecycle events. |
| SC-005 | Clean cleanup (OS camera indicator clears in ≤ 5 s) | 🚧 not automatable | — | Chromium fake-device never lights the OS indicator; remains on the manual checklist. |
| SC-006 | Permission-denied clarity within 2 s | ⚠ partial | `scenario-3-media-failure-retry.spec.ts` | Clarity asserted ("Camera or microphone unavailable"). "Names which permission was denied" not satisfied — product-copy gap, not an e2e gap. |
| SC-007 | Screen share stop detected ≤ 2 s | 🚧 phase-11 | — | |
| SC-008 | Every learning outcome observable | 🚧 phase-11 | — | Needs the full feature set in place. |
| SC-009 | Ungraceful disconnect detected ≤ 10 s | 🕓 deferred (→ EC-008/EC-009) | — | Unlocked when EC-008/EC-009 scenarios ship. |

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
