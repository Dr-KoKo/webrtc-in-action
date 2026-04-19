# Phase 1 — Data Model

**Feature**: 1:1 WebRTC Learning Call
**Branch**: `001-webrtc-1to1-call`
**Date**: 2026-04-19

This document defines the **in-memory models** on both sides of the system.
Nothing persists — no database, no disk — per Non-Goals. Every model here
exists to coordinate the signaling handshake and the local WebRTC state
machine; once a room empties, its state is garbage.

All state transitions in this document are exhaustive; unlisted transitions
are invalid and MUST be rejected with an `error occurred` log entry.

---

## Part A — Server state model (Go, in-memory)

### A.1 `RoomManager`

The single top-level service. Holds all active rooms and mediates
admission decisions.

**Fields**:

| Field | Type | Purpose |
|---|---|---|
| `rooms` | `map[string]*Room` | active rooms keyed by `roomId` |
| `mu` | `sync.RWMutex` | protects `rooms` |
| `roomIDRegex` | `*regexp.Regexp` | server-authoritative validation (FR Room-ID) |

**Methods**:

- `Admit(roomID, conn) (*Participant, JoinResult)` — validates,
  creates or reuses a `Room`, enforces capacity (2 reserved slots),
  attaches a new `Participant`, returns the Join Result.
- `Release(roomID, peerID, reason)` — releases a slot (media failure,
  leave, ungraceful disconnect). If the room becomes empty, removes
  it from the map.

### A.2 `Room`

**Fields**:

| Field | Type | Purpose |
|---|---|---|
| `id` | `string` | room identifier |
| `slots` | `[2]*Participant` | fixed-size capacity; nil slots are free |
| `admissionCounter` | `uint64` | monotonic per-room; assigned on admission; establishes offerer ordering |
| `createdAt` | `time.Time` | diagnostic only |
| `mu` | `sync.Mutex` | serializes all room-scoped mutations |

**Derived properties** (computed, not stored — spec Key Entities):

- **Slot occupancy** (for admission decisions):
  - `0 reserved` if all slots nil
  - `1 reserved` if exactly one slot non-nil
  - `2 reserved` if both slots non-nil ⇒ reject further joins with
    `join_rejected_room_full`
- **Call-readiness** (for role assignment + UI broadcast):
  - `empty` — no reserved participants
  - `waiting_for_media` — at least one reserved participant where
    `state != ready`
  - `waiting_for_peer` — exactly one reserved participant with
    `state == ready` AND one nil slot
  - `paired` — both slots non-nil AND both participants
    `state == ready` ⇒ server MUST send `ready_for_offer`

**Invariants**:

- Capacity for admission is based on reserved slot count, never on
  call-readiness.
- `admissionCounter` is assigned once per successful `join_accepted`
  and never revoked; a released slot does not renumber the remaining
  participant.
- Role assignment (`ready_for_offer`) is sent **exactly once** per
  pairing attempt.

### A.3 `Participant`

**Fields**:

| Field | Type | Purpose |
|---|---|---|
| `peerID` | `string` | server-assigned, UUIDv4 |
| `roomID` | `string` | back-reference |
| `admissionOrder` | `uint64` | from `Room.admissionCounter` at join |
| `state` | `ParticipantState` | see enum below |
| `conn` | `*websocket.Conn` | the active WS connection |
| `connMu` | `sync.Mutex` | serializes writes to `conn` |
| `joinedAt` | `time.Time` | diagnostic only |
| `lastSeen` | `time.Time` | updated on each received frame / Pong |

**`ParticipantState` enum**:

```
joining       -- transient: join_room received, validation in progress
pending-media -- join_accepted sent; awaiting media_ready or media_failed
ready         -- media_ready received; eligible for pairing
in-call       -- role assigned; ready_for_offer sent
leaving       -- explicit leave_room received
failed        -- released due to media failure / disconnect
```

**State transitions** (legal only):

```
            +-- join_rejected --> (participant not created)
join_room --+
            +-- join_accepted --> joining --> pending-media
                                                    |
                                                    |-- media_ready --> ready
                                                    |
                                                    |-- media_failed --> failed (released)
                                                    |
                                                    +-- disconnect --> failed (released)

ready --+-- both-peers-ready (paired) --> in-call (ready_for_offer sent)
        |
        +-- disconnect --> failed (released)

in-call --+-- leave_room --> leaving --> (released)
          |
          +-- disconnect --> failed (released)

(any state) --+-- release --> (participant removed from slot)
```

Rejected transitions (MUST produce an `error` response, not a state
change):

- `media_ready` while `state != pending-media`
- `offer` / `answer` / `ice_candidate` while `state != in-call`
- `leave_room` while `state == joining` (before `join_accepted`)

### A.4 `JoinResult` enum (server → client)

```
join_accepted                          -- admission succeeded
join_rejected_room_full                -- 2 slots already reserved
join_rejected_invalid_room             -- room ID failed validation
participant_released_media_failed      -- post-admission media failure
```

Only one of these is ever sent per `join_room` request (plus follow-up
messages on state changes).

### A.5 `PeerPresence` events (server → both clients)

When any participant's `state` changes, the server broadcasts a
`peer_joined` / `peer_left` / `peer_state_changed` event to both
reserved slots (including the participant themselves). This powers
FR-022b (bidirectional peer-presence updates).

**Not a model** — this is derived from `Participant.state`; listed
here because it's the only cross-participant signal the server emits
on top of 1:1 message relay.

---

## Part B — Client state model (TypeScript, in-memory)

The client is a React + reducer combination. All long-lived state lives
in one reducer (`rootReducer`) plus a small set of WebRTC-owned
objects (`RTCPeerConnection`, `MediaStream`s, `RTCDataChannel`) stored
in refs (they are not serializable and must not live in React state).

### B.1 `SessionState` — top-level finite state machine

```
idle
  │  user clicks Join
  ▼
joining           -- join_room sent; awaiting join_accepted
  │  join_accepted received
  ▼
pending-media     -- acquiring getUserMedia()
  │  media acquired
  ▼
waiting-for-peer  -- media_ready sent; awaiting peer
  │  ready_for_offer received (role = offerer | answerer)
  ▼
connecting        -- offer/answer/ICE in progress
  │  connectionState = "connected"
  ▼
connected         -- media flowing; DataChannel open
  │  user clicks Leave              │  remote peer_left            │  ICE failure
  ▼                                  ▼                              ▼
leaving                           waiting-for-peer              failed
  │  cleanup done                                                (manual Leave/Rejoin)
  ▼
idle
```

**Transitions on failure**:

- `join_rejected_*` → `idle` with visible error.
- `getUserMedia()` rejects during `pending-media` → send
  `media_failed` → `failed` (terminal-ish; user can click Leave to
  return to `idle`).
- WebSocket closes unexpectedly → `failed` (per spec FR-005 split).
- ICE `connectionState === "failed"` → `failed`.

**Never-legal transitions** (client asserts impossible):

- `connecting` → `waiting-for-peer` (except via explicit reset)
- Any state → `idle` without cleanup (Phase 1/Phase N contract:
  cleanup MUST run before re-entering `idle`)

### B.2 `LocalMediaState`

| Field | Type | Notes |
|---|---|---|
| `camera` | `"on" \| "off" \| "unavailable"` | reflects track `enabled` and device presence |
| `microphone` | `"on" \| "off" \| "unavailable"` | as above |
| `screenShare` | `"idle" \| "active" \| "stopping"` | reflects screen capture state |
| `localStream` | `MediaStream \| null` | kept in ref, not in reducer state |
| `screenStream` | `MediaStream \| null` | kept in ref |
| `cameraTrack` | `MediaStreamTrack \| null` | held to enable back-swap after screen stops |

Transitions: mutations happen only via user action (toggle mic /
toggle camera / start screen / stop screen) OR device events
(`getUserMedia` resolve/reject, browser `ended` event on screen).
Each transition emits a `media_state` signaling message (FR-014a).

### B.3 `RemoteMediaState`

Mirrors the remote peer's reported state:

| Field | Type | Source |
|---|---|---|
| `microphone` | `"on" \| "off" \| "unknown"` | remote `media_state` signaling |
| `camera` | `"on" \| "off" \| "unknown"` | remote `media_state` signaling |
| `screenShare` | `"active" \| "inactive" \| "unknown"` | remote `media_state` signaling |

`unknown` is the default before the first `media_state` is received.

### B.4 `PeerConnectionState`

Reflects the `RTCPeerConnection` getters, updated from the peer
connection event handlers:

| Field | Type | From |
|---|---|---|
| `connectionState` | `RTCPeerConnectionState` | `oniceconnectionstatechange` + `onconnectionstatechange` |
| `iceConnectionState` | `RTCIceConnectionState` | `oniceconnectionstatechange` |
| `iceGatheringState` | `RTCIceGatheringState` | `onicegatheringstatechange` |
| `signalingState` | `RTCSignalingState` | `onsignalingstatechange` |

All four power persistent UI indicators (FR-022a).

### B.5 `DataChannelState`

| Field | Type | Values |
|---|---|---|
| `state` | string | `"absent" \| "connecting" \| "open" \| "closing" \| "closed"` |
| `dc` | `RTCDataChannel \| null` | kept in ref |

Transitions map 1:1 to `RTCDataChannel.readyState` events.

### B.6 `IceBuffer`

```ts
type IceBuffer = {
  pending: RTCIceCandidateInit[];  // received but not yet addable
  remoteDescriptionSet: boolean;
};
```

**Rules** (from research §6):

- On `ice_candidate` receive: if `remoteDescriptionSet === false`,
  push to `pending`. Else call `addIceCandidate`.
- On `setRemoteDescription` resolve: set `remoteDescriptionSet = true`,
  drain `pending` into `addIceCandidate` in order, clear `pending`.
- On cleanup: clear `pending`.

### B.7 `EventLog`

Append-only, bounded ring buffer (e.g., last 500 entries) of:

```ts
type EventLogEntry = {
  id: string;              // monotonic, for React keys
  ts: number;              // Date.now()
  type: EventType;         // from US5 lists
  direction: "local" | "remote" | "system";
  summary: string;         // human-readable
  details?: object;        // dev-mode expand; never raw secrets
  transport?: "signaling" | "datachannel";  // only for chat events
};
```

Rendered in the UI panel (FR-020/021). Entries are NEVER mutated after
insertion.

### B.8 `ChatMessage` (per message, not a state model)

```ts
type ChatMessage = {
  id: string;
  from: "self" | "peer";
  text: string;              // already validated (FR-015a: trimmed, ≤500 chars)
  ts: number;
  transport: "signaling" | "datachannel";
};
```

Kept in React state; no persistence. Cleared on `idle` re-entry.

### B.9 Validation at client/server boundary

Every incoming WS message is parsed through the Zod schema for its
declared `type` (research §9). Validation failure ⇒ log an
`error occurred` entry AND do NOT update state AND send an `error`
message back to the server.

---

## Part C — Relationships & invariants across both sides

### C.1 `admissionOrder` is the single source of truth for role

- Server stamps `admissionOrder` once at `join_accepted`.
- Server compares admission orders at `paired` transition; lower =
  offerer.
- Client never computes its role locally.

### C.2 `media_ready` is the only signal that advances pairing

- Server MUST ignore any `offer`/`answer` from a participant whose
  `state != in-call`.
- Client MUST NOT create an `RTCPeerConnection` before receiving
  `ready_for_offer` (answerer may create it on receipt of
  `ready_for_offer` before the remote offer arrives).

### C.3 `media_state` is authoritative for remote media UI

- The remote peer's `media_state` message is the ONLY source for
  `RemoteMediaState`. The client does not infer "remote muted" from
  packet-level silence.

### C.4 Contract version (`v: 1`)

- Both sides read `v` from every inbound message. A message with
  `v != 1` is rejected with an `error occurred` log and no state
  change. Contract-version bumps are backward-incompatible changes
  per Constitution G-3.

### C.5 Cleanup ordering (client)

On leave / failure / `peer_left`:

1. Stop all local `MediaStreamTrack`s (camera, mic, screen).
2. Close `RTCDataChannel` (if open).
3. Close `RTCPeerConnection`.
4. Send `leave_room` if WS is still alive and state is in-call or
   connecting.
5. Drop references (`localStream`, `screenStream`, `dc`, `pc`, ICE
   buffer, remote media state).
6. Reset reducer to `idle`.
7. Log `cleanup completed`.

This ordering matters — stopping tracks before closing the peer
connection lets the remote side receive `ended` track events instead
of ICE disconnect noise.

### C.6 Cleanup (server)

On WS close or `leave_room`:

1. Mark participant `leaving` then `failed`/released (whichever
   applies).
2. Remove from `Room.slots`.
3. Broadcast `peer_left` to the remaining participant (if any) —
   carries the `peerId` and the reason (`graceful_leave` |
   `disconnect` | `media_failed`).
4. If `Room` is now empty, remove it from `RoomManager.rooms`.

---

## Part D — Entities cross-referenced to spec

| Spec entity | Server model | Client model |
|---|---|---|
| Room (server-side) | `Room` | `sessionState` observes, not mirrors |
| Join Result | `JoinResult` enum | derived into `SessionState` transition |
| Participant | `Participant` | `localParticipant` + `remoteParticipant` views |
| Signaling Message | (envelope; handled by codec) | Zod-validated `SignalingMessage` |
| Peer Connection | N/A (never relayed) | `PeerConnectionState` + ref'd `RTCPeerConnection` |
| Event Log Entry | (server log, separate) | `EventLogEntry` |
