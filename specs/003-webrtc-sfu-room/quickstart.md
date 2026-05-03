# SFU Mode Quickstart

**Feature**: SFU Learning Room (003)
**Branch**: `003-webrtc-sfu-room`
**Plan**: [plan.md](./plan.md) | **Spec**: [spec.md](./spec.md)
**Contract**: [contracts/signaling-protocol.md](./contracts/signaling-protocol.md)

This quickstart is the manual verification checklist for SFU mode. It
sits **alongside** the 001 quickstart
(`specs/001-webrtc-1to1-call/quickstart.md`) and the 002 quickstart
(`specs/002-webrtc-mesh-room/quickstart.md`) without replacing
either. Both 001 and 002 quickstarts MUST continue to pass after 003
ships (SC-S06).

> Project memory note: this repo's e2e workflow uses
> `docker compose up --build` for Playwright / manual verification. Do
> not run `npm run dev` in isolation — SFU mode depends on the
> signaling server being live on `/ws/sfu`.

The quickstart maps directly onto SC-S01..SC-S08 and L19..L25; each
section calls out the IDs verified.

---

## 1. Prerequisites

Same as 001 / 002 plus:

- Docker + Docker Compose installed.
- Modern Chromium (current or current-1) is the primary target.
  Firefox / Safari are best-effort.
- A working camera + microphone on the host.
- For 4 simultaneous browser windows: a host with ≥ 16 GB RAM and a
  CPU that can run 4 simultaneous WebRTC encoders is comfortable;
  weaker hosts may need to drop to 2–3 windows for the multi-party
  steps.
- For the §6 failure scenario (mediafabric impaired with control
  plane alive): the signaling binary built with the
  `sfu_test` build tag, started with
  `SFU_FAULT_INJECT=mediafabric_unavailable=1` (controlled by an
  environment variable; the hook is gated and not present in
  production builds).

---

## 2. Bring the system up

From the repository root:

```bash
docker compose up --build
```

You should see two services come up:

- `signaling` — Go service serving `:8080` with **all three**
  endpoints:
  - `/ws` (001 v1) — unchanged.
  - `/ws/mesh` (002 v2) — unchanged.
  - `/ws/sfu` (003 v3) — new in this feature.
- `frontend` — Vite dev server on `:5173` serving **all three**
  routes:
  - `/` → 001 1:1 mode.
  - `/mesh/:roomId` → 002 mesh mode.
  - `/sfu/:roomId` → 003 SFU mode (this feature).

Health-check signal:

```bash
curl http://localhost:8080/healthz                       # → {"status":"ok"}
wscat -c ws://localhost:8080/ws/sfu                      # connects without error
# Send: {"v":1,"type":"join_room","roomId":"x","payload":{}}
# Expect: {"v":3,"type":"error","payload":{"code":"unsupported_version", ...}}
```

---

## 3. Open the browsers

For a 4-person SFU test you need **4 browser contexts** that the
browser will treat as independent peers:

- 4 separate Chromium windows (or `Profile A`, `B`, `C`, `D`), or
- 2 Chromium windows + 1 Firefox + 1 Chromium incognito, or
- 4 different physical machines on the same LAN.

Open `http://localhost:5173/sfu/demo` in all four. Each window should
display the persistent **SFU mode (capacity 4)** badge in the header
(FR-004). 1:1-mode windows show "1:1 mode"; mesh-mode windows show
"Mesh mode (capacity 4)".

> Visual differentiation: the SFU mode badge is visually distinct
> from the mesh badge at a glance (color / typographic emphasis).

---

## 4. Walk the happy path

### 4.1 First peer joins (US1 AS#1, US3, US4)

In the first browser:

1. Click **Join SFU room**.
2. Grant camera + microphone permission.
3. Confirm the **Local preview** shows your video; **Mic / Camera**
   indicators show on.
4. Confirm the **Roster** shows yourself only with
   `presence: media-ready`.
5. Confirm the **SFU transport panel** progresses through the four
   Principle V states:
   - `signalingState`: `stable → have-local-offer → stable`,
   - `iceGatheringState`: `gathering → complete`,
   - `iceConnectionState`: `checking → connected`,
   - `connectionState`: `connecting → connected`.

   Exactly **one** transport row is rendered (FR-064). It belongs to
   the local browser↔SFU transport. ✅ **L21** observable.
6. Confirm the **SFU cost summary** reads:
   - `participants: 1`
   - `local SFU transport count: 1`
   - `subscribed remote count: 0`
   - `outgoing senders: 2` (1 audio + 1 video)
   - `uplink copies per published track: 1`
   - `forwarding deliveries per published track: 0`
   - `forwarding deliveries from this participant: 0`
   - `server media role: forwarding (SFU)`
   - `media path: browser ↔ SFU`
7. Confirm the **Published** panel reads:
   `audio (microphone), video (camera)` — with
   PublisherState `publishing` for both. ✅ **L22** observable
   (publisher role is distinct from subscriber role).
8. Confirm the **Event log** has entries:
   - `room joined`,
   - `local media acquired`,
   - `media publish started` (×2, scoped to `publisher`),
   - `offer created`, `answer received`,
   - `ICE candidate sent` / `ICE candidate received` (×N),
   - `connection state changed → connected`,
   - `local track published` (×2).

### 4.2 Second peer joins (US1 AS#2, US3 AS#2, US4)

In a second browser, repeat the join. After both peers' transports
are `connected`:

1. Each browser sees **one remote tile** with the other's video and
   plays the other's audio.
2. The remote tile is labeled **"via SFU"** (or equivalent
   media-path label per FR-046). ✅ **SC-S05** observable.
3. The remote tile shows **subscription** + **per-track** + **remote
   presence** indicators. It does **NOT** render
   `SFUTransportState` as if it were per-remote (FR-013, FR-065).
   ✅ **L21 / L22** distinct.
4. The Published panel still shows 2 PublishedTracks; the
   **Subscribed** panel now shows the remote's 2 SubscribedTracks
   with `state: subscribed`.
5. Cost summary updates: `participants: 2`, `subscribed remote count:
   1`, `forwarding deliveries per published track: 1`,
   `forwarding deliveries from this participant: 2`. ✅ **L20**
   observable (uplink stayed at 1 copy per track).
6. Event log on each side has a `subscribed_track_added` (×2) and
   `remote track received` entry for the other's tracks. Existing
   `connectionState` indicator did NOT regress
   (FR-025); a `signalingState` excursion `stable → have-local-offer
   → stable` was visible during the renegotiation that added the
   recvonly transceivers.

### 4.3 Third and fourth peers join (US1 AS#3, SC-S01, L19/L20/L21/L22)

Repeat the join in browsers C and D. After D joins:

1. Within 30 s of D's join, every browser sees three remote tiles
   with live audio + video forwarded by the SFU. ✅ **SC-S01**.
2. Existing browsers' `connectionState`/`iceConnectionState`
   indicators did NOT regress (FR-025). Their `signalingState`
   excursed during renegotiation; now back to `stable`.
3. Cost summary at N = 4:
   - `participants: 4`
   - `local SFU transport count: 1`
   - `subscribed remote count: 3`
   - `outgoing senders: 2`
   - `uplink copies per published track: 1`
   - `forwarding deliveries per published track: 3`
   - `forwarding deliveries from this participant: 6`
   - `server media role: forwarding (SFU)`
   - `media path: browser ↔ SFU`. ✅ **L19, L20, L23, L24**.
4. **Mesh-vs-SFU comparison panel** (FR-074) shows the side-by-side
   mesh/SFU table:
   - Mesh N=4: 6 peer-pairs, 3 local PCs, 6 outgoing senders, server
     media role = none.
   - SFU N=4: 1 local PC, 1 uplink per pub track, 3 forwarded
     deliveries per pub track, server media role = forwarding.
   ✅ **L24** observable.
5. Learning inspector renders the §20 fields populated:
   - SDP m-line summary: `audio: 1, video: 1` for the local
     transport's send section, plus 6 recvonly mediation entries
     (3 audio + 3 video).
   - ICE candidate types observed: at minimum `host`, possibly
     `srflx` if STUN is configured, possibly `relay` if TURN is
     configured.
   - Per-PublishedTrack: `1 inbound source observed at SFU,
     forwarded to 3 subscriber deliveries`. ✅ **L19, L20, L22, L23**.
6. ✅ **SC-S03**: each of L19..L25 has at least one observable
   moment by this point. (L25 verification follows in §6.)

### 4.4 Fifth peer is rejected (US1 AS#4, SC-S04)

In a 5th browser, try to join `demo`. Expect:

1. A clear modal/banner: **"SFU room 'demo' is full (capacity 4)."**
2. The 5th browser does NOT enter the SFU page.
3. The four already-in-room peers see **no** state change — no
   roster update, no renegotiation, no cost summary change.
4. Event log on the 5th browser contains a `join rejected` entry
   with `result: join_rejected_room_full`.

---

## 5. Media controls and screen share

### 5.1 Mute / camera toggle (US5, EC-007)

In one browser (say A):

1. Click **mic: on → off**. Confirm A's local mic indicator updates
   immediately. Within 2 s, B / C / D's remote tiles for A show
   the muted indicator (FR-033).
2. Confirm A's **SFU transport panel** does NOT show a
   `signalingState` transition during this — i.e., **no
   renegotiation** for mute (EC-007). Event log shows
   `media state changed` only.
3. Click **camera: on → off**. Confirm A's local preview shows the
   camera-off placeholder immediately; B / C / D's remote tiles for
   A reflect camera-off within 2 s. No renegotiation.
4. Click **mic: off → on** and **camera: off → on**; reverse
   transitions occur with the same latency budgets.

### 5.2 Screen share (US6, DD-004 = A, FR-042, EC-012)

In two browsers (A and B):

1. Click **Share screen** on A; pick a window/screen.
2. Confirm:
   - A's **Published** panel re-labels the video publication
     `video (screen)`.
   - A's **outgoing senders** count remains **2** (no new sender
     added).
   - A's `signalingState` did NOT transition (no renegotiation for
     source swap).
   - Within 5 s, B / C / D's remote tile for A shows A's screen
     content. ✅ **L20** (uplink stayed at 1 copy per published
     track).
3. While A is still sharing, click **Share screen** on B. Confirm
   both A's and B's screens are visible to C and D simultaneously
   (DD-004 = A: concurrent sharers allowed, no `screen_share_busy`).
4. Stop A's screen share via the **app Stop button**. Confirm A's
   video sender's track returns to camera (or camera-off if camera
   was off); B / C / D see the change within 5 s.
5. Repeat A's screen share. Stop it via the **browser-native "Stop
   sharing" affordance** (the OS bar). Confirm cleanup happens
   identically (same `replaceTrack(camera | null)` path; event log
   `screen share stopped` with `trigger: browser-native`).
6. Cancel the OS picker (don't pick anything). Confirm:
   - No sender mutation.
   - No `media_state_update` emitted.
   - Event log: `screen share cancelled`.

---

## 6. Failure scenarios (US7, L25)

Each step verifies a distinct failure domain (FR-080..FR-083, EC-001
.. EC-016).

### 6.1 Graceful leave (FR-014, FR-084, US1 AS#5, SC-S04)

In one browser (say D), click **Leave SFU**.

Expect on A / B / C within ≤ 10 s:

1. D's tile and three SubscribedTracks (D audio + D video; well, two
   tracks on the local view — D's audio + D's video) are removed
   from each remaining participant.
2. Event log on each remaining peer: `participant left` with
   `reason: graceful_leave`, plus `subscribed_track_removed` per
   leg.
3. Cost summary updates: `participants: 3`, `subscribed remote
   count: 2`, `forwarding deliveries per published track: 2`.
4. Other peers' transport indicators stay `connected`. Their
   PublisherStates unchanged.

### 6.2 Ungraceful disconnect (US1 AS#5, US7 AS#1, SC-S04, EC-004)

In one peer (say D), close the browser tab without clicking Leave.

Expect on A / B / C within ≤ 10 s (server: 5 s ping + 5 s pong-timeout):

1. `participant_left { reason: "disconnect" }` broadcast.
2. Same cleanup as §6.1.
3. The remaining peers' transport indicators stay `connected`. Their
   PublisherStates unchanged.

### 6.3 Single browser↔SFU transport failure (US7 AS#2, FR-080, L25)

Pick one peer (say A). Force only A's SFU media transport to fail
(simulate via `chrome://webrtc-internals` "Close" on A's PC, or via
Chromium's "Offline" network mode briefly on A's tab — be aware this
may also drop A's signaling socket; if so the test conflates with
§6.4).

Expect on A:

1. A's **SFU transport panel** transitions to `connectionState:
   failed`. The transport row shows `failed`.
2. A's PublisherStates and SubscriberStates flag the affected
   transport.
3. UI offers **leave/rejoin only**. There is **no manual Reconnect
   button** (PD-001). ✅ **L25**: this is per-local-SFU-transport
   failure, not a peer-pair failure.

Expect on B / C / D:

1. They receive `subscribed_track_removed` for A's tracks (their
   forwarding legs from A end). A's remote tile shows a transport
   failure indicator.
2. Their own transports stay `connected`. Their own PublisherStates
   unchanged.
3. The UI does NOT label this as a mesh-style "peer-pair failed"
   (FR-080, NFR-005, L25).

### 6.4 Single subscribed remote track failure (US7 AS#3, FR-082, EC-006)

Pick one peer (say B). Simulate B's video source ending without B's
transport failing (e.g. via `chrome://webrtc-internals`, end B's
video track, or unplug B's camera).

Expect on A / C / D within a few seconds:

1. The remote tile for B shows a track-ended indicator on the video
   only.
2. The remote audio subscription for B continues; B's audio is still
   playing.
3. B's transport indicator remains `connected`.
4. Event log scopes the entry to `subscriber` + `media-track`.

### 6.5 mediafabric impaired but control plane alive (US7 AS#4 (a), FR-083 (a))

Restart the signaling service with the fault hook enabled (see §1):

```bash
docker compose down
SFU_FAULT_INJECT=mediafabric_unavailable=ready docker compose up --build
```

(or use the project's documented test-build invocation.)

With 4 participants joined and connected, trigger the impairment
(via a test-only HTTP endpoint or by sending a SIGUSR1 — the exact
trigger is implementation-defined under the `sfu_test` build tag).

Expect on every browser within a few seconds:

1. A room-level **"SFU unavailable"** banner appears (FR-083 (a)).
2. The banner is visually distinct from any per-participant
   transport-failed indicator.
3. The UI does NOT present the SFU as a peer that "left".
4. Event log on each browser: `error occurred` scoped to `SFU` with
   `code: sfu_unavailable`.
5. Recovery is leave/rejoin (PD-001). No automatic reconnect.

### 6.6 Whole signaling process down (US7 AS#4 (b), FR-083 (b), SC-S04b, EC-005 (b), EC-010)

With 4 participants joined and connected:

```bash
docker compose stop signaling
```

Expect on each browser within ≤ 5 s:

1. A local **"Signaling connection lost"** banner appears
   (`role="alert"`, `aria-live="assertive"`,
   `data-testid="sfu-signaling-error-banner"`).
2. The banner is labeled differently from the §6.5 "SFU
   unavailable" banner so a learner can tell them apart. ✅ **L25
   sub-(d)** observable.
3. ✅ **SC-S04b** (banner within 5 s).
4. Already-established media MAY continue carrying media until the
   transport itself fails on its own (EC-010); this is documented
   in the banner copy.
5. There is **no automatic reconnect** (PD-001).
6. Recovery is leave/rejoin once the operator does
   `docker compose start signaling`.

### 6.7 Permission-denied retry (EC-001, FR-031)

Open `/sfu/demo` in a fresh browser context, click **Join SFU room**,
deny camera/microphone permission.

Expect:

1. A clear permission-denied banner with a **Retry** affordance.
2. Server has emitted `participant_released { result:
   "participant_released_media_failed" }` and freed the slot.
3. The four already-in-room peers see `roster_update { presence:
   "released", reason: "media_failed" }` for the released participant.
4. The **slot is released** — a 5th browser may now successfully
   join (ECs do not produce phantom occupied slots; FR-031).

---

## 7. SC-S07 / SC-S08 verification

### 7.1 No media persistence (SC-S07)

After the 4-browser run completes, on the host:

```bash
docker compose ps                                         # signaling + frontend running
docker exec -it $(docker compose ps -q signaling) ls /tmp # no recording artifacts
docker exec -it $(docker compose ps -q signaling) ls /var/log
docker exec -it $(docker compose ps -q signaling) find / -name '*.webm' -o -name '*.mp4' 2>/dev/null | head
# expect: empty
```

No files should be present. mediafabric writes nothing to disk. ✅
**SC-S07**.

### 7.2 No raw SDP / ICE / TURN / RTP rendering or logging (SC-S08, NFR-004, EC-016)

Per-surface check:

1. **Event log**: scroll through the entire 4-browser session's log
   on one browser. No entry contains a line starting with `v=0` or
   `candidate:`; no TURN credential URL appears.
2. **Learning inspector**: open the inspector panel; verify it
   renders only summaries (m-line counts, candidate-type breakdown,
   STUN/TURN configured/unavailable). No raw SDP block, no raw ICE
   string, no raw SSRC hex, no TURN credential.
3. **Browser DevTools console**: check the Network tab for
   `/ws/sfu`; raw SDP and raw ICE candidate strings ARE present in
   the wire payload (this is allowed by FR-090 (c)). The render
   layer must not surface them.
4. **Backend logs**:
   ```bash
   docker compose logs signaling | grep -E '(v=0|candidate:|^\s*"sdp"|TURN_PASSWORD)'
   # expect: no matches
   ```
   ✅ **SC-S08**.

---

## 8. Regression — 001 + 002 (SC-S06)

### 8.1 001 quickstart regression

Run `specs/001-webrtc-1to1-call/quickstart.md` end-to-end. ALL steps
must pass unchanged. The 1:1 mode badge, `/`, `/ws`, v1 contract,
1:1 happy path, 1:1 chat, 1:1 screen share, 1:1 failure cases — all
unaffected by 003.

### 8.2 002 quickstart regression

Run `specs/002-webrtc-mesh-room/quickstart.md` end-to-end. ALL steps
must pass unchanged. Mesh mode badge, `/mesh/:roomId`, `/ws/mesh`,
v2 contract, 4-peer mesh happy path, mesh chat, screen-share,
per-pair failure / manual reconnect, ungraceful disconnect — all
unaffected by 003.

### 8.3 Boundary audit + test gates

```bash
bash scripts/audit-boundaries.sh
cd signaling && go test ./...
cd ../frontend && npm run typecheck && npx vitest run
# (optional) npx playwright test
```

All must exit clean.

---

## 9. Coverage summary

| Success criterion | Verified in |
|---|---|
| **SC-S01** (4-browser SFU within 30 s) | §4.3 |
| **SC-S02** (cost summary differs from mesh on ≥ 4 dimensions) | §4.3 step 4 |
| **SC-S03** (L19..L25 each observable in UI / event log) | §4.1, §4.3, §6 |
| **SC-S04** (≤ 10 s for participant_left fan-out) | §6.1, §6.2 |
| **SC-S04b** (≤ 5 s local signaling-error) | §6.6 |
| **SC-S05** (browser ↔ SFU label everywhere) | §4.2 step 2, §4.3 step 3 |
| **SC-S06** (001 + 002 quickstarts pass unchanged) | §8 |
| **SC-S07** (no media persistence) | §7.1 |
| **SC-S08** (no raw SDP / ICE / TURN / RTP rendering or logging) | §7.2 |

| Learning outcome | Where observable |
|---|---|
| **L19** browser↔SFU media path | §4.1 step 5; §4.3 step 3 |
| **L20** uplink fan-out reduction | §4.3 step 3; §5.2 |
| **L21** SFU is a WebRTC participant | §4.1 step 5 |
| **L22** publisher / subscriber model | §4.1 step 7; §4.2 step 4; §5.1 |
| **L23** RTP forwarding without recording | §4.3 step 5; §7.1 |
| **L24** SFU vs mesh cost comparison | §4.3 step 4; §8.2 |
| **L25** SFU failure domains | §6.3, §6.4, §6.5, §6.6 |

If any row above does not pass on a clean walkthrough, the SFU mode
is not ready to ship.
