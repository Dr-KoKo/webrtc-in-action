# Mesh Mode Quickstart

**Feature**: Multi-party Mesh WebRTC Learning Room (002)
**Branch**: `002-webrtc-mesh-room` | **Date**: 2026-04-25
**Plan**: [plan.md](./plan.md) | **Spec**: [spec.md](./spec.md)
**Contract**: [contracts/signaling-protocol.md](./contracts/signaling-protocol.md)

This quickstart is the manual verification checklist for mesh mode. It
sits **alongside** the 001 quickstart (`specs/001-webrtc-1to1-call/quickstart.md`)
without replacing it; the 001 procedure must continue to pass after
002 ships (M12 DoD).

> Project memory note: this repo's e2e workflow uses `docker compose
> up --build` for Playwright / manual verification. Do not run `npm
> run dev` in isolation — the mesh mode depends on the signaling
> server being live on `/ws/mesh`.

---

## 1. Prerequisites

Same as 001:

- Docker + Docker Compose installed.
- Modern Chromium (current or current-1) is the primary target. Firefox / Safari are best-effort; see §7.
- A working camera + microphone on the host.
- For more than 2 browser windows on one machine: a CPU/RAM that can run 4 simultaneous WebRTC encoders. A laptop with ≥ 16 GB RAM is comfortable; weaker hosts may need to drop to 2–3 windows.

---

## 2. Bring the system up

From the repository root:

```bash
docker compose up --build
```

You should see two services come up:

- `signaling` — Go service serving `:8080` with both `/ws` (001 v1) and `/ws/mesh` (002 v2). The 002 endpoint logs `mesh_ws_connected` / `mesh_ws_disconnected` per connection.
- `frontend` — Vite dev server on `:5173` serving both routes:
    - `/` → 001 1:1 mode (unchanged).
    - `/mesh/:roomId` → 002 mesh mode.

Health-check signal: `curl http://localhost:8080/healthz` returns
`{"status":"ok"}` and `wscat -c ws://localhost:8080/ws/mesh` connects
without error.

---

## 3. Open the browsers

For a 4-person mesh test you need **4 browser contexts** that the
browser will treat as independent peers:

- 4 separate Chromium windows (or `Profile A`, `B`, `C`, `D`), or
- 2 Chromium windows + 1 Firefox window + 1 Chromium incognito, or
- 4 different physical machines on the same LAN.

Open `http://localhost:5173/mesh/demo` in all four. Each window should
display the persistent **Mesh mode (capacity 4)** badge in the header
(FR-004); 1:1-mode windows would show a different "1:1 mode" badge.

---

## 4. Walk the happy path

### 4.1 First peer joins

In the first browser:
1. Click **Join mesh room**.
2. Grant camera + microphone permission.
3. Confirm the **roster** shows yourself only with `presence: media-ready`.
4. Confirm the **mesh cost summary** reads:
    - `participants: 1`
    - `local peers: 0`
    - `local PCs: 0`, `local DCs: 0`, `outgoing senders: 0`
    - `pairs: connected 0 / connecting 0 / failed 0 / pending 0`
    - `room-wide pairs: 0`
5. Confirm the **event log** has entries `room joined`, `local media acquired`, `mesh roster snapshot received`, `mesh roster updated (self → media-ready)`.

### 4.2 Second through fourth peers join

In each of the next three browsers:
1. Click **Join mesh room** in the same room (`demo`).
2. Grant camera + mic permission.
3. After media-ready, the existing browsers should see the new peer's tile transition `joined → media-ready → connecting → connected` over a few seconds.

After the fourth peer is connected, every browser should see:
- 3 remote tiles, each showing live video + audio (you should hear an echo or feedback if all four mics are unmuted; mute three to confirm).
- Cost summary at `N = 4`:
    - `participants: 4`
    - `local peers: 3`
    - `local PCs: 3`, `local DCs: 3`, `outgoing senders: 6` (3 audio + 3 video)
    - `pairs: connected 3 / 0 / 0 / 0`
    - `room-wide pairs: 6`
- Event log has, per pair: `peer pair pairing started`, `offer created` (only on the lower-`admission_index` peer), `offer received` (only on the higher), `answer created/received`, `ICE candidate sent/received`, `ICE gathering state changed → complete`, `connection state changed → connected`, `DataChannel opened`, `remote track received`. Every entry carries the relevant `peerId` / `pairId` (FR-061).
- **SC-001 satisfied**: 4-browser mesh call established on first try.
- **SC-003 satisfied**: each newcomer reaches all-pairs-connected within ~10 s of their `media-ready` (the plan-prompt's stricter "3 browsers within 7 s" target should also be met on a typical local-dev laptop).
- **L13** observable: open three remote tiles' state pills side-by-side and confirm `connectionState`, `iceConnectionState`, `iceGatheringState`, `signalingState`, `dataChannel` for each are independently rendered. (US3 AS#1.)
- **L14** observable: cost summary numbers above show the O(N²) shape on the room and the O(N) shape per local participant.
- **L18** observable: the existing pairs (between A/B/C) did not flicker out of `connected` when D joined; only the new pairs' tiles progressed.

### 4.3 Fifth peer is rejected

In a 5th browser, try to join `demo`. Expect:
1. A clear modal/banner: **"Mesh room 'demo' is full (capacity 4)."**
2. The 5th browser does NOT enter the mesh page.
3. **SC-004**: rejection completes within 2 s.
4. The four already-in-room peers see **no** state change (no roster update, no pair touch). EC-002 / FR-022a + FR-022a invariants hold.

### 4.4 DataChannel mesh chat fan-out (L17, SC-006)

In one browser (say, A):
1. Type `"hi everyone"` in the mesh chat input. Press send.
2. A's chat UI renders the message **once** (FR-052a). Confirm there are not four copies of the message in A's chat list.
3. A's MeshChat fan-out indicator reads **`3 / 3 delivered`**.
4. A's event log gets exactly **3** `chat message sent (datachannel)` entries, one tagged `pairId=1-2`, one `pairId=1-3`, one `pairId=1-4` (or whichever pair IDs apply on your run).
5. Each of B, C, D renders the message once with `chat message received (datachannel)` entry.
6. B, C, D's event logs each show one received entry; the chat UIs show one rendered message each.
7. SC-006 met.

Now close one peer's `DataChannel` artificially via `chrome://webrtc-internals` (or by killing one peer's PC); send another chat message and confirm:
- A's fan-out indicator reads `2 / 3 delivered` with one `chat message send skipped (dc not open)` event-log entry naming the closed peer.
- The two reachable peers receive normally.
- EC-008 verified.

### 4.5 Concurrent screen share (L16, SC-009)

In two browsers (B and C):
1. Click **Share screen** on B; pick a window/screen.
2. While B is still sharing, click **Share screen** on C.
3. On A and D: confirm both tiles update independently — B's tile shows B's screen; C's tile shows C's screen (FR-043).
4. On B: confirm A's tile of B and C's tile of B both transitioned `local track replaced (camera→screen)` per pair (FR-040). The cost summary's `outgoing video senders` count for B remains **3** (NOT 4 — `replaceTrack` does not add a sender; FR-070 + plan-prompt L16 invariant).
5. Confirm there is **no prompt, no auto-stop** of B when C starts sharing. EC-011 verified, FR-041 honored.
6. Stop B's share via the in-app button; B's tiles on A/C/D revert to camera (or camera-off if camera is off). C's share continues. EC-009/EC-010 verified.

### 4.6 Per-pair failure isolation + manual reconnect (L15, SC-007, US7 AS#3)

Pick one pair, e.g., A↔B. Force a failure:

- Easiest: open `chrome://webrtc-internals` on A, find the PC for A↔B, and press **Close**, OR use Chromium's "Offline" network mode briefly on B's tab (be careful: this may also drop B's signaling socket — see §5.4 for the local-signaling-loss case).

Expect on A:
1. A's tile-of-B turns `failed` (per-pair terminal).
2. The **PartialMeshBadge** appears next to the cost summary because at least one pair (`A↔C`, `A↔D`) is still `connected` and at least one (`A↔B`) is `failed` (FR-065).
3. Cost summary updates: `pairs: connected 2 / failed 1`.
4. A's tiles of C and D remain `connected` — no whole-room cleanup. SC-007 met.
5. Event log has `peer pair failed` tagged `pairId=1-2` (or whichever) with reason.
6. A's tile-of-B exposes a **Reconnect** button (FR-026).

Click **Reconnect** on A's tile-of-B:
1. The event log on A shows `peer pair reconnect requested` then `peer pair fresh attempt started` with a new `pairEpoch=2`.
2. A's tile-of-B passes through `connecting → connected` again under the new epoch.
3. A's tiles of C and D **never flicker** out of `connected` — confirm in the event log that there are no `connection state changed` entries with `pairId ∈ {A-C, A-D}` during this whole reconnect cycle.
4. US7 AS#3 + R-M2 verified.

For R-M3 simultaneous-reconnect-clicks: induce a failure on A↔B, then click Reconnect on A AND on B at virtually the same time. Expect: one fresh attempt completes; the loser sees an `error stale_pair_epoch` log entry; one reconnect cycle, not two.

### 4.7 Ungraceful disconnect (SC-005a)

In one peer (say D), close the browser tab without clicking Leave.

Expect on A, B, C within ≤ 10 s:
1. D's tile transitions to `left` (Spec FR-013 + EC-006).
2. D's tile is removed.
3. The cost summary recomputes (`participants: 3`, `local peers: 2`, etc.).
4. Event log on each remaining peer has `peer left` with `reason: "disconnect"`.
5. The remaining peers' other pair states (A↔B, A↔C, B↔C) are unaffected.
6. SC-005a met.

### 4.8 Local signaling loss (SC-005b, EC-012)

In one peer (say A), block `/ws/mesh` via DevTools' Network panel
"Block request URL" (or kill the WebSocket via the `chrome://webrtc-internals`).

Expect on A within ≤ 5 s:
1. The `LocalParticipant.fsm` flips to `signaling-error`; a banner appears: **"Signaling connection lost. Other peers may see you as disconnected."**
2. Event log gets `signaling error`.
3. Already-connected pairs (A↔B, A↔C, A↔D) MAY continue to carry media briefly — this is the honest WebRTC behavior. Confirm by speaking briefly; the audio may still cross until ICE keepalive eventually fails.
4. The banner offers a **Leave mesh** action.
5. SC-005b met.

From the **other peers' viewpoint**, A appears as `left` within ≤ 10 s
once the server's Pong timeout fires. SC-005a applies symmetrically.

### 4.9 Graceful leave

In one peer, click **Leave mesh**. Expect:
1. That peer's local tracks stop (camera light off, mic muted in OS).
2. The other three peers see this peer transition to `left` and tile removed.
3. Cost summary on each remaining peer updates.
4. The leaver returns to the lobby with no event-log error.
5. EC-005 verified.

---

## 5. Manual failure-path tests

Each maps directly to one or more EC-/SC- IDs. Run after Phase M11.

### 5.1 Permission denied (EC-003 pre-admission)

Reject camera permission **before** clicking Join. Expect:
1. The frontend never sends `join_room` (input validation fails).
2. UI shows a clear permission-error with a Retry button.
3. No other browsers see this user — no roster entry, no roster update.

### 5.2 Permission denied (EC-003 post-admission)

Click Join, then deny permission in the browser prompt. Expect:
1. Frontend sends `media_failed`.
2. Other browsers receive `mesh_roster_update { presence: 'released', reason: 'media_failed' }` for this peer; the peer is removed from their rosters.
3. The local UI shows `LocalParticipant.fsm = released` (or `media-error`) with a Retry affordance.
4. **No peer-pair teardown** occurs on any other peer (the failed joiner never had a pair). Verify via the event log — no `peer pair *` entries reference this `peerId`.

### 5.3 Pair ICE failure (EC-004)

See §4.6 above.

### 5.4 Local WebSocket disconnect (EC-012)

See §4.8 above.

### 5.5 Concurrent screen-share start (EC-011)

See §4.5 above.

### 5.6 Browser-native screen-share stop (EC-010)

While sharing, click the browser's native "Stop sharing" bar (NOT the
in-app button). Expect:
1. The local outgoing video reverts to camera (or camera-off) on every connected pair via `replaceTrack`.
2. `pair_media_state { screenShare: 'inactive' }` is sent once; server fans out to all other room members.
3. Event log has `screen share stopped` (source=`browser-native`) and one `local track replaced (screen→camera)` per pair.

### 5.7 5th-peer rejection while a 4th is mid-`pending-media` (US1 AS#3 amendment)

If you can time it, attempt a 5th join while the 4th is still in
`joined` (i.e., before they grant camera permission). Expect: the 5th
is rejected because the room has 4 reserved slots (the 4th's slot
counts even pre-`media-ready`). EC-002 + Spec FR-011 verified.

---

## 6. 001 regression checklist (M12 DoD)

After 002 ships, run the existing 001 quickstart in full:

- [ ] `quickstart.md §4.1` (001 1:1 room entry) — passes unchanged.
- [ ] `§4.2` (mic + camera toggles).
- [ ] `§4.3` (chat over DataChannel — final 1:1 transport).
- [ ] `§4.4` (screen sharing).
- [ ] `§4.5` (third-peer rejection in 1:1 room).
- [ ] `§4.6` (graceful leave).
- [ ] `§4.7` (event-log lifecycle verification — SC-004 in 001 numbering).
- [ ] `§5.1`..`§5.7` (failure-path tests).
- [ ] `go test ./...` in `signaling/` green; no new failures.
- [ ] Vitest suites under `frontend/src/{state,signaling,webrtc,components,tests}` green.

If any 001 row regresses: **stop**, do NOT ship 002, file a
Constitution Check violation referring to plan §6 (preservation
boundary), and remediate.

---

## 7. Cross-browser notes

- **Chromium current + current-1** — primary target; everything in §4 should pass.
- **Firefox** — best-effort. Known divergences: `iceconnectionstatechange` orderings around `failed → disconnected → failed`; `getDisplayMedia` UX. The per-pair pills should still update; transient extra transitions are normal.
- **Safari** — best-effort. `getDisplayMedia` requires a recent user gesture; codec defaults differ from Chromium.

The mesh feature does NOT introduce a codec-selection UI (Non-Goals + plan-prompt). Cross-browser interop relies on whatever the browsers default to.

---

## 8. What to watch when something is wrong

| Symptom | First place to look |
|---|---|
| 5th peer is admitted (should be rejected) | `signaling/internal/mesh/manager.go` — `JoinOrCreate` slot-occupancy guard |
| Existing pairs flicker out when newcomer joins | server's `OnMediaReady` is touching existing pairs; check FR-022a invariant |
| Reconnect leaves stale messages applied to fresh PC | `pairEpoch` check missing on either server or client; see contract §3.10–§3.16 |
| Chat message renders 4 times in sender's UI | local-echo + per-pair receive being conflated; FR-052a invariant violated |
| Sender count says 4 instead of 3 after screen share start | `addTransceiver` was used somewhere instead of `replaceTrack`; plan §13 + FR-070 |
| `room_full` envelope type appears | v2 contract violation; rejection should be `join_rejected { result: "join_rejected_room_full" }` |
| `screen_share_busy` appears | v2 contract violation; mesh has no such concept |
| Whole room enters `failed` on one pair fail | FR-025/FR-065 violated; check `PartialMeshBadge` instead |
| 001 `/` route broken | preservation boundary breach; revisit plan §6, run the §6 regression list |

For raw protocol traffic, open DevTools → Network → WS for `/ws/mesh`.
SDP and ICE bodies are visible **in the browser** (they have to be —
the browser is the WebRTC endpoint), but they are **never** logged on
the server (NFR-003). Server logs JSON-structured events with
correlation IDs only.

---

## 9. Clean shutdown

```bash
docker compose down
```

No persistent state to clear (Spec Non-Goals: no recording, no chat
backfill).

---

## 10. Definition-of-Done checklist (per-phase use)

Each row matches one of M1–M12 in plan §18. A phase ships only when
its checklist is green.

| Phase | DoD checklist |
|---|---|
| **M1 — Route shell + `/ws/mesh`** | [ ] `/` still loads 001 unchanged. [ ] `/mesh/demo` shows mesh-mode badge. [ ] `wscat -c ws://localhost:8080/ws/mesh` connects + logs. [ ] 001 `quickstart §4.1` passes. |
| **M2 — v2 contract + validators** | [ ] Every v2 type has Go validator + Zod schema. [ ] Round-trip contract tests green on both sides. [ ] No ad-hoc JSON sent or accepted. |
| **M3 — Admission + roster + 4-cap + 5-reject** | [ ] 4 simulated WS connections admitted; 5th gets `join_rejected { result: "join_rejected_room_full" }` < 2 s (SC-004). [ ] Roster snapshot delivered exactly once at admission. [ ] Updates ordered by monotonic `serverSeq`. |
| **M4 — Mesh frontend shell + roster + log** | [ ] 4 windows joining `/mesh/demo` see each other in the roster < 1 s. [ ] Every roster change becomes a peer-scoped log entry with `peerId` (FR-061). |
| **M5 — Two-phase join + readiness** | [ ] Refusing camera permission yields `released` on every other client. [ ] `media-ready` reachable in 4-window run. |
| **M6 — Pair negotiation + epoch** | [ ] All pairs reach `signalingState=stable`. [ ] Stale `pair_offer` returns `error stale_pair_epoch`. |
| **M7 — ICE + remote tiles + indicators** | [ ] §4.2 above passes (4-browser mesh). [ ] All 4 lifecycle states display per remote peer. [ ] SC-001 + SC-003 met. [ ] **L13** demonstrable. |
| **M8 — DataChannel chat fan-out** | [ ] §4.4 above passes. [ ] Chat UI shows message exactly once on send (FR-052a). [ ] SC-006 met. [ ] **L17** demonstrable. |
| **M9 — Media controls + server-fan-out media_state** | [ ] Toggling mic/cam on one peer updates the other 3 within ~1 s. [ ] Sender emits exactly one signaling message per toggle (test asserts). |
| **M10 — Concurrent screen share** | [ ] §4.5 passes. [ ] Sender count remains `2 × (N − 1)` across toggles. [ ] SC-009 met. [ ] **L16** demonstrable. |
| **M11 — Failure isolation + reconnect** | [ ] §4.6 passes. [ ] Simultaneous reconnect race resolves deterministically. [ ] SC-007 met. [ ] **L15** demonstrable. |
| **M12 — Cleanup + ungraceful + 001 regression** | [ ] §4.7 (SC-005a) + §4.8 (SC-005b) + §4.9 pass. [ ] §5.1..§5.7 pass. [ ] §6 001 regression checklist green. [ ] All Vitest + `go test ./...` green. [ ] **L18** demonstrable from §4.2 newcomer flow. |

A complete walk through this quickstart from a clean state, with all
boxes ticked, is the **acceptance** for the mesh feature; combined
with M12's 001 regression run it is the SC-002 (mode coexistence)
proof.
