# Quickstart — 1:1 WebRTC Learning Call

**Feature**: 1:1 WebRTC Learning Call
**Branch**: `001-webrtc-1to1-call`
**Date**: 2026-04-19

This document tells a fresh contributor (or returning learner) how to
stand up the whole system and drive the happy path end-to-end on a
single laptop. It is also the **manual verification checklist** used
at each phase's Definition of Done (plan §Phased Implementation).

Everything here assumes **local development** — the MVP explicitly
does not ship a production deployment story (spec Non-Goals).

---

## 1. Prerequisites

- Docker + Docker Compose v2 (`docker compose`, not `docker-compose`).
- Two browser windows on the same machine, at least one of them a
  current Chromium release (Chrome / Edge / Arc). Firefox and Safari
  are supported; divergences are noted per phase.
- A working webcam and microphone. (Spec Assumptions — no hardware
  fallback in MVP.)
- No other service occupying ports `5173` (frontend dev), `8080`
  (signaling), or `3478` UDP (coturn, optional).

No Node, no Go, no other tooling needs to be installed on the host —
Docker Compose handles both.

---

## 2. Bring the system up

From the repository root:

```bash
cp .env.example .env
docker compose up --build
```

`.env.example` is the prod-persona source of truth (ports, STUN URL,
`LOG_FORMAT=json`, heartbeat timings); copying it to `.env` lets
docker-compose auto-load it. For contributor inner-loop work against
the dev persona (`docker-compose.dev.yml` + `Dockerfile.dev`), use
`cp .env.dev.example .env.dev` and pass `--env-file .env.dev` —
`.env.dev` is not auto-loaded.

Expected output (abbreviated — prod compose, distroless signaling +
`vite preview`):

```
signaling-1  | {"time":"…","level":"INFO","msg":"signaling server starting","event":"server_start","addr":":8080"}
frontend-1   | ➜ Local:   http://localhost:5173/
```

Signaling passes its `/healthz` before the frontend container starts
(`depends_on: service_healthy` in `docker-compose.yml`).

If port 5173 or 8080 is already in use, either free it or override
`FRONTEND_PORT` / `SIGNALING_PORT` in `.env` (see `docker-compose.yml`
comments). TURN is **disabled by default**; see §6 to enable it.

---

## 3. Open two browsers

Open two separate browser windows or profiles at:

```
https://localhost:5173/
```

Both windows will show a self-signed-certificate warning. That is
expected — the cert is generated at build time by
`@vitejs/plugin-basic-ssl` and is dev-only. Per-browser bypass is
documented in §7.

Two tabs of the same profile usually work, but two **different**
profiles (or two different browsers) is the recommended test matrix
because each profile has its own camera/mic permission state.

---

## 4. Walk the happy path

This is the **canonical end-to-end check** referenced by every phase
DoD (§10) and by spec SC-001..SC-008.

### 4.1 Room entry

1. In each window, enter the same room ID, e.g., `demo`.
2. Click **Join**.
3. The browser will prompt for camera and microphone. **Accept in both
   windows.**

**Expected**:

- Local video preview appears in each window.
- Session-state indicator shows `connecting` then `connected` within
  ~5 s (SC-002).
- Event log on each side contains (at minimum):
  `room joined`, `peer joined`, `local track added`, `offer created`
  or `offer received`, `answer created` or `answer received`,
  `ICE candidate sent`, `ICE candidate received`, `remote track
  received`, `connection state changed → connected`.
- The two logs are **not identical** — each shows its own perspective.

### 4.2 Media controls

4. In window A, click **Mute mic**. Then **Camera off**. Then restore
   both.

**Expected in window B**:

- The remote media state indicator for window A updates immediately
  (`microphone: off` then `on`, `camera: off` then `on`).
- Audio from A is silent while muted; video is blanked/frozen while
  camera is off.
- `media toggled` event-log entries appear on **both** sides (local
  logs the local toggle; remote logs the remote's `media_state`).

### 4.3 Chat

5. In window A, type "hello" and send. In window B, type "hi" and
   send.

**Expected**:

- Both messages appear in both windows, attributed to the sender.
- Each chat event-log entry is tagged `transport: datachannel` once
  the final DataChannel milestone is reached; `transport: signaling`
  during the optional interim milestone.
- `chat-channel state` indicator shows `open`.

### 4.4 Screen sharing

6. In window A, click **Share screen**. Pick a window or tab.

**Expected in window B**:

- Remote video swaps to the shared content (single outgoing video
  slot — FR-017).
- Event log on both sides shows `screen share started` and a
  `track replaced` entry.
- Screen-share state indicator = `active` on A; remote screen-share
  indicator = `active` on B.

7. In window A, click **Stop sharing** (in the app).

**Expected**:

- Remote video reverts to window A's camera.
- Event log: `screen share stopped`, `track replaced`.
- Screen-share state indicator = `idle`.

8. Start sharing again, then stop via the **browser's own** "Stop
   sharing" banner at the top of the browser window.

**Expected**: identical revert behavior as step 7; event log entry
tagged as originating from the browser control (not the app button).

### 4.5 Third-peer rejection

9. Open a **third** browser window, navigate to the same URL, enter
   room ID `demo`, click **Join**.

**Expected**: the third window shows a clear `room_full` error
within 2 s (SC-003); windows A and B continue uninterrupted. If
window C's user has not yet granted camera/mic, it is still rejected
before any permission prompt (server rejects on join, before media
acquisition).

### 4.6 Leave

10. In window B, click **Leave**.

**Expected on A**:

- Session state → `waiting-for-peer` (not `failed`).
- Event log: `peer left` with reason `graceful_leave`,
  `cleanup completed`.
- Camera/mic **in-use** indicator on A remains on (A is still media-
  ready). On B, the in-use indicator disappears (B's tracks stopped).

11. In window A, click **Leave**.

**Expected on A**: session state → `idle`; camera/mic in-use
indicator disappears within 5 s (SC-005).

### 4.7 Event-log lifecycle verification (SC-004)

After the full walk, scroll through window A's event log. Every entry
from the US5 Base lifecycle list MUST appear in document order,
relevant to A's perspective. Window B's log is the complementary
half. Combined, both logs MUST contain every Base event + every
Conditional event that was exercised.

---

## 5. Manual failure-path tests

Run each of these **individually** from a clean state (both windows
in `idle`, or restart `docker compose`). Each corresponds to a
constitution-mandated failure case.

### 5.1 Permission denied (EC-004)

- In window B, deny camera **or** microphone permission when prompted.

**Expected**:

- Window B shows a clear permission-denied error **before** any
  offer/answer occurred.
- Window A remains in `waiting-for-peer`; event log on A shows
  `peer joined` → `pending peer released` (B's slot was released).
- Window B shows a **Retry** button where the browser allows it
  (Chromium: yes after a page reload; Firefox: yes after re-prompt;
  Safari: browser permission must be reset in system settings).

### 5.2 No camera or microphone hardware (EC-005)

- Physically disconnect the webcam (or use a profile with no
  devices), then try to join.

**Expected**: clear error naming the missing device; no negotiation
begins.

### 5.3 ICE failure (EC-006 / EC-007)

- Easiest reproduction: block all UDP on your local machine's
  firewall for ~10 s after clicking Join in window B.

**Expected**: window B enters terminal `failed` state with
**Leave / Rejoin** affordance (no auto-retry); event log shows
ICE-state transitions ending in `failed` and an ICE-failure `error
occurred` entry.

### 5.4 Ungraceful disconnect (EC-009)

- After a successful connect, **close window B** (⌘W / Ctrl+W) without
  clicking Leave.

**Expected on A** within 10 s (SC-009):

- `peer_left` event with `reason: disconnect`.
- Session state returns to `waiting-for-peer`.

### 5.5 Signaling WebSocket disconnect (EC-010)

- With both windows connected, stop the signaling container:
  `docker compose stop signaling`.

**Expected on both windows**: signaling-state error surfaces in the
UI; the peer connection itself continues carrying audio/video
(because WebRTC is P2P — this is a teachable moment). A new Join
requires restarting the signaling service.

### 5.6 Screen-share browser-native stop (EC-011)

- Start screen sharing, then click the browser's native "Stop
  sharing" control (the bar Chrome/Firefox shows at the top of the
  shared surface).

**Expected**: outgoing video reverts to camera; both logs show
`screen share stopped` tagged with the browser-originated source.

### 5.7 Leave during negotiation (EC-012)

- Click Join in both windows. Before the `connected` indicator
  appears, click Leave in one.

**Expected**: no zombie `RTCPeerConnection` remains; the other side
returns to `waiting-for-peer` or `idle` cleanly; `cleanup completed`
in the log.

---

## 6. Optional: enable coturn (TURN relay)

Uncomment the `coturn` service block in `docker-compose.yml` and
fill the five TURN variables into `.env` (copied from `.env.example`
per §2) — the `VITE_TURN_*` trio goes to the browser, the
`TURN_USERNAME` / `TURN_PASSWORD` pair matches them on the coturn
side:

```bash
# edit .env — defaults in .env.example are commented out; uncomment + fill:
VITE_TURN_URL=turn:localhost:3478
VITE_TURN_USERNAME=webrtc
VITE_TURN_CREDENTIAL=replace-me-dev-only
TURN_USERNAME=webrtc
TURN_PASSWORD=replace-me-dev-only

docker compose up --build
```

For the dev persona (`docker-compose.dev.yml`), do the same in
`.env.dev` (copied from `.env.dev.example`) and launch with
`docker compose -f docker-compose.dev.yml --env-file .env.dev up --build`.

To exercise the "when TURN becomes necessary" learning outcome,
either:

- block UDP to/from your STUN server at the OS firewall to force the
  browser to fall back to TURN, OR
- use a second machine on a separate, NAT'd network.

**Expected** (with TURN working): the `Learning Inspector` panel
(FR-030) shows:

- `TURN configured: yes`
- `relay candidate present: yes`
- `STUN configured: yes`, `srflx observed: yes/no` depending on your
  network.

---

## 7. Cross-browser notes

| Action | Chromium | Firefox | Safari |
|---|---|---|---|
| `getUserMedia` permission | per-site once; persists | per-site once | per-site every page load |
| `getDisplayMedia` | full app / window / tab | full screen / window / tab | full screen only |
| Browser-native "Stop sharing" | top banner | top banner | menu-bar icon |
| Safari-specific | — | — | MUST be triggered by a direct user gesture (click), not a re-render |

These diverge only on UX; the signaling contract and state machine
are identical across browsers.

---

## 8. What to watch when something is wrong

1. **Open the in-UI event log first** — the whole point of this
   project is that you do not need devtools for the common cases
   (FR-021).
2. **Check the persistent state indicators** (FR-022a/b). A mismatch
   between the four `RTCPeerConnection` states tells you which stage
   failed:
   - `signalingState` stuck at `have-local-offer` → answer never
     arrived (server relay issue).
   - `iceConnectionState` stuck at `checking` → no viable ICE path
     (STUN/TURN / firewall issue).
   - `iceGatheringState` completes with no `srflx` / `relay`
     candidate → STUN/TURN unreachable.
3. **Check the Learning Inspector** (FR-030) for STUN/TURN
   configuration and observed candidate types.
4. **Only then** open browser devtools.
5. `docker compose logs signaling | jq` for server-side issues. The
   server MUST never log SDP / ICE / credentials (NFR-003).

---

## 9. Clean shutdown

```bash
docker compose down
```

Volumes and networks are removed. Nothing persists — there is
nothing to persist (spec Non-Goals).

---

## 10. Definition-of-Done checklist (per-phase use)

Every phase in plan.md §Phased Implementation declares which of the
following items its DoD requires. Copy the relevant ticks into the
phase's task list.

- [ ] Docker Compose brings the system up with `docker compose up`
- [ ] Signaling container passes `/healthz`
- [ ] Two windows can enter the same room
- [ ] Local video preview in both windows
- [ ] Offer/answer/ICE completes; `connectionState = connected`
- [ ] Remote video visible in both windows
- [ ] Event log shows full Base lifecycle (US5)
- [ ] Persistent state indicators match live state (FR-022a/b)
- [ ] Third-peer rejection (§4.5) works
- [ ] Media toggles visible on remote (§4.2)
- [ ] Chat round-trip works and is tagged with transport (§4.3)
- [ ] Screen share swap + stop from app + browser-native stop (§4.4)
- [ ] Leave clears state and stops device-in-use indicator
- [ ] All §5 failure paths behave as specified
- [ ] No SDP / ICE / TURN-credential content in any log
- [ ] No `innerHTML` of user input anywhere in the UI (NFR-006)
