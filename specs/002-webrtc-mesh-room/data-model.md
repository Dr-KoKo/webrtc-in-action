# Phase 1 Data Model: Multi-party Mesh WebRTC Learning Room

**Branch**: `002-webrtc-mesh-room` | **Date**: 2026-04-25
**Plan**: [plan.md](./plan.md) | **Spec**: [spec.md](./spec.md)
**Contract**: [contracts/signaling-protocol.md](./contracts/signaling-protocol.md)

This document is the canonical model for both the mesh signaling
server (Go) and the mesh frontend (TypeScript). The 001 data model
(`specs/001-webrtc-1to1-call/data-model.md`) is referenced for
behavior the mesh implementation MUST NOT change. Mesh-specific
state lives in:

- Go: `signaling/internal/mesh/`
- TS: `frontend/src/features/mesh/state/`, `frontend/src/features/mesh/webrtc/`

The mesh data model deliberately keeps **three state surfaces separate**
(Spec FR-013a, plan §9): local participant, remote roster, peer-pair.
Conflating them is a defect.

---

## Part A — Mesh server state model (Go, in-memory)

### A.1 `MeshRoomManager`

Top-level registry. Owns the set of mesh rooms keyed by `roomId`.
Concurrent-safe via a single `sync.Mutex`. Located at
`signaling/internal/mesh/manager.go`.

```go
type MeshRoomManager struct {
    mu    sync.Mutex
    rooms map[string]*MeshRoom        // key: roomId
    cfg   Config
}

type Config struct {
    MaxParticipants int           // = 4 (FR-011)
    PingIntervalMs  int           // shared with 001; default 5000
    PongTimeoutMs   int           // shared with 001; default 5000
    IceServers      []IceServer   // shared env-loaded list
}
```

**Operations**:

| Method | Description |
|---|---|
| `JoinOrCreate(ctx, roomId, ws) (*MeshRoom, *Participant, error)` | Validate `roomId`, allocate or fetch the `MeshRoom`, allocate a slot. Returns `ErrRoomFull` if 4 slots are reserved. |
| `Leave(ws) error` | Find the participant for this WS, run §C.3 cleanup. |
| `LookupBySocket(ws) (*MeshRoom, *Participant, bool)` | Fast inbound-message routing. |

**Invariants**:

- 001's `RoomManager` is **not** edited. Mesh has its own registry.
- Mesh and 001 may share the same `roomId` string without collision; lookups are scoped per registry.

### A.2 `MeshRoom`

One mesh room. Lives in `signaling/internal/mesh/room.go`.

```go
type MeshRoom struct {
    mu               sync.Mutex
    roomId           string
    slots            [4]ReservedSlot
    participants     map[PeerId]*Participant
    admissionCounter uint64                  // monotonic; never reused; starts at 1
    pairs            map[PairId]*Pair        // pairId = "<lo>-<hi>"
    pairEpoch        map[PairId]uint64       // current epoch per pair; starts at 1, monotonic
    rosterSeq        uint64                  // monotonic; bumped on every roster broadcast
    createdAt        time.Time
}

type ReservedSlot struct {
    index uint8                              // 0..3
    state SlotState                          // free | reserved
    peerId PeerId                            // set when state == reserved; cleared on free
}

type SlotState int
const (
    SlotFree SlotState = iota
    SlotReserved
)
```

**Operations**:

| Method | Description |
|---|---|
| `Admit(peerId PeerId) (*Participant, error)` | Find a `SlotFree` slot, mark `SlotReserved`, allocate `admission_index = ++admissionCounter`, create `Participant`. Returns `ErrRoomFull` if all 4 reserved. |
| `EmitRosterSnapshot(p *Participant) RosterSnapshot` | Build the snapshot for FR-012a. `serverSeq = rosterSeq` (frozen at the moment). |
| `BroadcastRosterUpdate(subject *Participant, presence Presence, reason Reason)` | Bump `rosterSeq`; emit one `mesh_roster_update` to every participant in the room (S→B). |
| `OnMediaReady(p *Participant)` | Transition `p.readiness = MediaReady`; broadcast roster update; for each remote participant currently in `MediaReady`, emit `pair_negotiation_instruction` for the new pair. |
| `OnReconnectPair(p *Participant, pairId PairId, observedEpoch uint64) error` | If `pairEpoch[pairId] != observedEpoch` ⇒ `ErrStalePairEpoch`. Else bump `pairEpoch[pairId] += 1`, transition `Pair.state = Reconnecting`, emit `pair_reconnect_instruction` to both peers. |
| `RelayPairMessage(from PeerId, msg PairMessage)` | Validate `pairId` + `pairEpoch == pairEpoch[pairId]`, set `from`, forward to the named `to`. For `pair_media_state`, fan out to every other participant. |
| `OnLeave(p *Participant, reason Reason)` | See §C.3. |

**Invariants**:

- `admissionCounter` is monotonic per `MeshRoom` and **never decremented or reused**, even when a slot frees (§A.4 rationale).
- `len(participants) == count of slots in SlotReserved state`.
- `pairs` and `pairEpoch` have the same key set; both are populated when the first pair eligibility for a `pairId` triggers (§A.5).
- 5th `Admit` call MUST return `ErrRoomFull` within the SC-004 latency.

### A.3 `Participant`

One admitted browser session. Lives in
`signaling/internal/mesh/participant.go`.

```go
type Participant struct {
    peerId         PeerId        // server-assigned UUIDv4
    admissionIndex uint64        // monotonic per MeshRoom
    readiness      Readiness     // joined | media-ready | released | left
    ws             *Conn         // *coder/websocket connection
    lastPongAt     time.Time     // updated on every Pong frame
    joinedAt       time.Time
    role           Role          // for the most recent pair instruction (informational)
}

type Readiness int
const (
    ReadinessJoined Readiness = iota
    ReadinessMediaReady
    ReadinessReleased
    ReadinessLeft
)
```

**State transitions** (server-side):

```
joined ────media_ready────▶ media-ready
   │                            │
   │ media_failed               │ leave_room | disconnect
   ▼                            ▼
released                       left
                                ▲
                                │ leave_room | disconnect from media-ready
                                │
```

- `released` is **terminal pre-pairing**. The participant never had a pair; no pair teardown is needed (Spec FR-013, FR-014, EC-003).
- `left` is **terminal post-pairing**. Every pair the participant was in must be closed (§C.3).
- `joined → released` happens when `media_failed` arrives.
- `media-ready → released` is **not** a valid transition (after pairs may exist). Departing from `media-ready` after a pair has formed goes to `left`.

### A.4 `PairId` and `Pair`

```go
type PairId string  // canonical form "<lo>-<hi>", lo < hi

type Pair struct {
    id        PairId
    loPeerId  PeerId   // participant with lower admission_index
    hiPeerId  PeerId   // participant with higher admission_index
    state     PairState
    createdAt time.Time
}

type PairState int
const (
    PairIdle         PairState = iota // both peers eligible; instruction not yet emitted
    PairPairing                       // instruction emitted; offer/answer/ICE in flight
    PairConnected
    PairFailed
    PairReconnecting
    PairClosed                        // one side has left; pair is gone
)
```

**`PairId` derivation rule**: given two participants `Pi` and `Pj` with
`admissionIndex_i` and `admissionIndex_j`, sort ascending and join with
`-`. E.g., indices `3` and `7` ⇒ `"3-7"`. **The participant with the
lower index is always the offerer.** This makes `PairId` a stable,
endpoint-agnostic key that survives reconnects.

**Why monotonic, never reused `admissionIndex`**: if a slot freed and a
newcomer reused the same index, two distinct pair attempts would share
the same `PairId` — confusing reconnect epoch bookkeeping and breaking
the invariant that `(roomId, PairId)` uniquely identifies a pair across
the room's lifetime. See research §5.

### A.5 `PairAttempt` (server-side bookkeeping)

The active pairing attempt for a given `PairId`. Implicit in
`pairEpoch[pairId]` — there is no separate map, but conceptually:

```text
PairAttempt = (
    pairId:    PairId,
    epoch:     uint64,          // current epoch
    state:     PairState,
    startedAt: time.Time,
    parentId:  PairAttempt?,    // the failed attempt this one supersedes (for log only)
)
```

Each `epoch` represents one fresh attempt:
- `epoch = 1` — initial attempt (created when both peers reach `media-ready`).
- `epoch = N+1` — fresh attempt after `reconnect_pair` from the previous attempt at `epoch = N`.

**Stale-message rule (server-side)**: the following pairwise
connection-attempt messages MUST carry `payload.pairEpoch` and MUST match
the server's current `pairEpoch[pairId]`:

- `pair_offer`
- `pair_answer`
- `pair_ice_candidate`
- `pair_failed`

Any mismatch ⇒ the server returns `error { code: "stale_pair_epoch" }`
to the sender and does NOT forward.

`pair_media_state` is **exempt** from this rule because it is
participant-level server-fan-out metadata and carries no `pairId` or
`pairEpoch` on the wire (contract §3.13). The server's relay validation
for `pair_media_state` is scoped to envelope + room membership + sender
readiness (`media-ready`), not pair epoch.

### A.6 `RosterSnapshot` and `RosterUpdate`

```go
type RosterEntry struct {
    PeerId         PeerId
    AdmissionIndex uint64
    Presence       Presence  // 7-state vocabulary; see below
}

type RosterSnapshot struct {
    RoomId       string
    ServerSeq    uint64        // = MeshRoom.rosterSeq at time of snapshot
    Participants []RosterEntry // includes the snapshot recipient
}

type RosterUpdate struct {
    RoomId         string
    ServerSeq      uint64        // monotonic; > previous broadcasts for this room
    SubjectPeerId  PeerId
    AdmissionIndex uint64
    Presence       Presence
    Reason         Reason
}

type Presence int
const (
    PresenceJoined Presence = iota
    PresenceMediaReady
    PresenceConnecting
    PresenceConnected
    PresenceFailed
    PresenceReleased
    PresenceLeft
)
```

**`Presence` derivation on the server** (Spec FR-013):

| Server context | Presence emitted |
|---|---|
| `Participant.readiness == Joined` and no pair connected | `joined` |
| `Participant.readiness == MediaReady` and no pair `PairConnected` | `media-ready` |
| Pair ↔ subject is `PairPairing` | per-recipient `connecting` (the recipient's view of subject) |
| Pair ↔ subject is `PairConnected` | per-recipient `connected` |
| Pair ↔ subject is `PairFailed` | per-recipient `failed` |
| `Participant.readiness == Released` | `released` |
| `Participant.readiness == Left` | `left` |

> Note: `connecting` / `connected` / `failed` are **per-pair**, hence
> per-(viewer, subject). The server emits the per-pair pair-state
> changes via `pair_negotiation_instruction` / `pair_reconnect_instruction`
> / `pair_failed`; the client locally derives its own `Presence` for
> each remote peer from the union of its `PairContext` states + roster
> events. The server's `mesh_roster_update` is authoritative for
> `joined`, `media-ready`, `released`, `left`. (Plan §9.5 / §9.2.)

### A.7 `Reason` (state-transition tag)

```go
type Reason int
const (
    ReasonAdmitted Reason = iota
    ReasonMediaReady
    ReasonMediaFailed
    ReasonPairConnecting
    ReasonPairConnected
    ReasonPairFailed
    ReasonGracefulLeave
    ReasonDisconnect
    ReasonPendingReleased
)
```

Carried in `mesh_roster_update.payload.reason` and `peer_left.payload.reason`
(only the leaver-side reasons there).

---

## Part B — Mesh client state model (TypeScript, in-memory)

Composed root reducer at
`frontend/src/features/mesh/state/index.ts`. Three top-level slices,
strictly separated per Spec FR-013a.

### B.1 `LocalParticipant` slice

`frontend/src/features/mesh/state/local.ts`.

```ts
type LocalParticipant = {
  fsm: 'idle' | 'joining' | 'joined' | 'media-ready' | 'in-room' | 'leaving' | 'left' | 'failed' | 'released' | 'media-error' | 'signaling-error'
  peerId?: string                     // server-assigned on join_accepted
  admissionIndex?: number             // server-assigned on join_accepted
  signalingTransport: 'connecting' | 'open' | 'closed'
  localMedia: {
    mic: 'on' | 'off'
    camera: 'on' | 'off'
    screen: 'inactive' | 'active'
  }
  errorBanner?: { kind: 'media-error' | 'signaling-error', detail?: string }
}
```

**FSM transitions**:

```
idle ──join_room──▶ joining ──join_accepted──▶ joined ──media_ready ack──▶ media-ready ──first pair connected──▶ in-room
                                  │                  │
                                  │                  └ media_failed ──▶ media-error (retry-able)
                                  └ join_rejected ──▶ idle (with banner)

in-room ──leave_room──▶ leaving ──cleanup ok──▶ left

(any) ──ws close while in-room──▶ signaling-error
(any) ──fatal local error──▶ failed
```

`released` is the local-self mirror of FR-013 `released` — used only when
the local participant's own `media_failed` causes the server to release
its slot (rare; the local UI typically renders the `media-error` banner
and goes back to `idle` on retry).

### B.2 `Roster` slice

`frontend/src/features/mesh/state/roster.ts`.

```ts
type Presence = 'joined' | 'media-ready' | 'connecting' | 'connected' | 'failed' | 'released' | 'left'

type RemoteParticipant = {
  peerId: string
  admissionIndex: number
  presence: Presence
  remoteMedia?: {
    mic: 'on' | 'off'
    camera: 'on' | 'off'
    screen: 'inactive' | 'active'
  }
  joinedAt?: number                   // local clock, set on first roster appearance
}

type Roster = {
  serverSeq: number                   // last applied; monotonic
  byPeerId: Record<string, RemoteParticipant>
}
```

**Inputs**:
- `mesh_roster_snapshot` — replaces `byPeerId` (excludes the local participant; that lives in `LocalParticipant`); sets `serverSeq`.
- `mesh_roster_update` — applies if `payload.serverSeq > state.serverSeq`; else dropped + log entry. Updates the matching `RemoteParticipant.presence` (and `joinedAt` on first appearance). On `presence: "released"` or `"left"`, removes the entry.
- `pair_media_state` — updates `RemoteParticipant.remoteMedia` for `from = subject`.
- `PairContext` derived presence — when a pair transitions `connecting → connected → failed`, the matching `RemoteParticipant.presence` is updated locally (the server's roster updates may lag the local pair state for short windows).

**Invariants**:
- `Roster.byPeerId` does NOT include the local participant.
- A `RemoteParticipant` is removed from the roster iff `presence ∈ {released, left}` is observed.
- `presence` derivation under conflict: client trusts `mesh_roster_update` for terminal/lifecycle states (`released`, `left`, `joined`, `media-ready`); for `connecting`/`connected`/`failed`, the local `PairContext` state is authoritative on each viewer's UI.

### B.3 `PairMap` and `PairContext`

`frontend/src/features/mesh/webrtc/pairContext.ts` and
`pairManager.ts`.

```ts
type Role = 'offerer' | 'answerer'

type PairContext = {
  pairId: string                      // "<lo>-<hi>"
  pairEpoch: number                   // monotonic per pair, server-assigned
  remotePeerId: string
  role: Role
  pc: RTCPeerConnection
  dc: RTCDataChannel | null           // offerer creates; answerer receives via ondatachannel
  audioSender: RTCRtpSender | null
  videoSender: RTCRtpSender | null
  iceBuffer: RTCIceCandidateInit[]    // remote candidates buffered until SRD complete
  states: {
    connection: RTCPeerConnectionState
    iceConnection: RTCIceConnectionState
    iceGathering: RTCIceGatheringState
    signaling: RTCSignalingState
    dataChannel: 'connecting' | 'open' | 'closing' | 'closed' | 'absent'
  }
  createdAt: number
  lastEventAt: number
}

type PairMap = Map<string /* pairId */, PairContext>
```

**Lifecycle invariants**:
- Created on `pair_negotiation_instruction` or `pair_reconnect_instruction`.
- `pairEpoch` is set on creation and never decreases.
- `audioSender` and `videoSender` are attached at creation by reusing the **same** local `MediaStreamTrack`s across all pairs (count invariant: `2 × (N − 1)` total senders for the local participant).
- Offerer: `dc = pc.createDataChannel('mesh-chat', { ordered: true })` BEFORE `createOffer`.
- Answerer: `dc = null` initially; populated in `pc.ondatachannel`.
- Disposal: `dc?.close(); pc.close(); states.dataChannel = 'closed'; states.connection = 'closed'`.
- Stale-epoch handler drops inbound messages whose `payload.pairEpoch < state.pairEpoch`.

### B.4 `IceBuffer` (per pair)

```ts
type IceBuffer = RTCIceCandidateInit[]
```

Behavior identical to 001's `IceBuffer` (data-model §B.6) but **scoped
per `PairContext`**. Inbound `pair_ice_candidate` is either added to
the matching pair's buffer (if `pc.remoteDescription === null`) or
applied via `pc.addIceCandidate(...)` immediately. On `setRemoteDescription`
completion, the buffer is drained. End-of-candidates (`candidate: null`)
is forwarded as-is.

### B.5 `Chat` slice

`frontend/src/features/mesh/state/chat.ts`.

```ts
type ChatMessage = {
  id: string                          // local UUIDv4
  authorPeerId: string                // local self for outgoing, remote for incoming
  text: string                        // ≤ 500 chars after trim, never raw HTML
  sentAt?: number                     // sender clock (set on outgoing send)
  receivedAt?: number                 // recipient clock (set on incoming receive)
}

type ChatFanOut = {
  messageId: string
  attempted: number                   // = current pair count at time of send
  succeeded: number
  skipped: { peerId: string, reason: 'dc_not_open' }[]
}

type ChatState = {
  messages: ChatMessage[]             // newest at the end
  fanOutByMessageId: Record<string, ChatFanOut>
}
```

**FR-052a invariants** (validated in `chatFanOut.spec.ts`):
- `messages` contains exactly **one** entry per local-sent message (local echo).
- `fanOutByMessageId[id].attempted == |PairMap|` at the time of send.
- Event log gets `attempted` `chat message sent` entries (one per pair, including skipped) + 1 chat-UI render.

### B.6 `EventLog` slice

`frontend/src/features/mesh/state/eventLog.ts`.

```ts
type EventScope = 'room' | 'peer' | 'pair' | 'local'

type EventEntry = {
  ts: number
  scope: EventScope
  peerId?: string                     // present for scope ∈ {peer, pair}
  pairId?: string                     // present for scope == 'pair'
  type: string                        // canonical name from Spec FR-060
  summary: string                     // short human-readable
  detail?: Record<string, unknown>    // structured (no SDP/ICE bodies)
}

type EventLogState = {
  buffer: EventEntry[]                // bounded ring; newest at end
  capacity: 1000
}
```

**FR-061 invariant**: every entry with `scope ∈ {peer, pair}` MUST
carry `peerId` (and `pairId` for pair scope). Room-scoped events MAY
omit both. Validated in `eventLog.spec.ts`.

### B.7 `Cost` selector

`frontend/src/features/mesh/state/cost.ts`. **Pure** selector over
`Roster` and `PairMap`. Output:

```ts
type MeshCostSnapshot = {
  participantCount: number            // |Roster.byPeerId| + 1
  localPeerCount: number              // |Roster.byPeerId| (= N − 1)
  localRTCPeerConnections: number     // |PairMap| (≤ N − 1; equals in happy path)
  localRTCDataChannels: number        // count of pairs with dc != null && dc.readyState != 'closed'
  outgoingAudioSenders: number        // count of pairs with audioSender != null
  outgoingVideoSenders: number        // count of pairs with videoSender != null
  outgoingMediaSenders: number        // = audio + video; INVARIANT: 2 × (N − 1) in happy path
  activeScreenSharers: number         // count of remotes whose remoteMedia.screen=='active' + (local.screen=='active' ? 1 : 0)
  pairsByState: {
    connected: number
    connecting: number
    failed: number
    released: number
    left: number
  }
  roomWidePairTotal: number           // = participantCount × (participantCount − 1) / 2 (= 6 at N=4)
}
```

Tested in `costSummary.spec.ts` for `N ∈ {1, 2, 3, 4}`.

---

## Part C — Cross-cutting invariants

### C.1 `admissionIndex` is the single source of truth for offerer

Spec FR-022 + plan §11. The participant with the lower `admissionIndex`
in a pair is **always** the offerer. The server emits role assignment
on every `pair_negotiation_instruction` and `pair_reconnect_instruction`;
clients MUST NOT recompute the role independently and MUST use the
server-emitted `role` field.

`pairId` is derived from `(min(i,j), max(i,j))` formatted as
`"<lo>-<hi>"`; this guarantees the same key on both endpoints.

### C.2 `pairEpoch` is the single source of truth for attempt freshness

Server-issued, server-incremented. Carried on every pairwise message
in `payload.pairEpoch`. Stale-message rule (§A.5) is enforced both
server-side (returns `error stale_pair_epoch`) and client-side
(silently dropped + logged). This is the **only** mechanism by which a
fresh manual reconnect (FR-026) is protected from late stale messages
of the failed attempt (R-M2).

### C.3 Cleanup ordering — three distinct paths

Mirrors 001's three cleanup paths but generalized to mesh's per-pair
context.

#### Path A — local Leave (user-initiated `leave_room`)

```
1. mark LocalParticipant.fsm = 'leaving'
2. for pair in PairMap.values():
     pair.dc?.close()
     pair.pc.close()
3. stop local MediaStreamTrack[s] (camera, mic, screen if active)
4. send leave_room (best-effort; WS may already be closing)
5. close WS
6. clear PairMap, Roster, ChatState; LocalParticipant.fsm = 'left'
7. eventLog.append('cleanup completed')
```

#### Path B — remote `peer_left` (single peer departed)

```
1. for pair in PairMap.values() with pair.remotePeerId == subject:
     pair.dc?.close()
     pair.pc.close()
     PairMap.delete(pair.pairId)
2. Roster.byPeerId[subject] is removed by the accompanying mesh_roster_update {presence:'left'}
3. KEEP local MediaStreamTrack[s] running (only the remote left)
4. LocalParticipant.fsm stays 'in-room'
5. eventLog.append('peer left', subject, reason)
```

This is **NOT** a local failure — Spec FR-025 isolation guarantees apply.
The cost summary recomputes; if any pair remains `connected`, the
PartialMeshBadge MAY toggle; if all remaining pairs are `connected`,
the badge clears.

#### Path C — single pair failure (`pair_failed`, ICE/DTLS failure on one pair)

```
1. let pair = PairMap.get(pairId)
2. pair.states.connection = 'failed'
3. Roster.byPeerId[pair.remotePeerId].presence = 'failed'
4. cost.pairsByState.failed += 1
5. PartialMeshBadge toggles if any other pair is 'connected' (FR-065)
6. eventLog.append('peer pair failed', pair.pairId, reason)

# the pair is NOT torn down here — the user MUST click Reconnect (FR-026)
# or click Leave on that tile
```

If the user later clicks **Reconnect** on this tile, server bumps
`pairEpoch[pairId]` and emits `pair_reconnect_instruction`; the client
then performs Path B-like teardown of the OLD `PairContext`,
constructs a NEW `PairContext` under the new `pairEpoch`, and rejoins
the pairing flow. **No other pair is touched throughout** — this is
US7 AS#3, FR-022a applied to non-newcomer pairs.

#### Path D — local signaling drop (EC-012, SC-005b)

```
1. on ws close while LocalParticipant.fsm ∈ {'media-ready', 'in-room'}:
     LocalParticipant.fsm = 'signaling-error'
     LocalParticipant.errorBanner = { kind: 'signaling-error' }
2. KEEP all PairContext entries running (P2P media may still flow)
3. NO automatic reconnect
4. user must click 'Leave mesh' to invoke Path A cleanup
```

### C.4 Server cleanup (mirror of client paths)

When the server detects a participant leaving (via `leave_room`, WS
close, or Pong timeout), it MUST:

1. Mark `Participant.readiness = Left` (or `Released` if `Joined` and
   never reached `MediaReady`).
2. Free the slot (set `slot.state = SlotFree`); **preserve the
   `admission_index` value** (do not reuse).
3. For each `Pair` involving the leaver, mark `Pair.state = PairClosed`.
   The `pairEpoch[pairId]` value stays in the map (history); this is OK
   because the pair will not be re-created (the leaver is gone).
4. Broadcast `mesh_roster_update { presence: 'left' | 'released', reason }`
   to all remaining participants.
5. If the leaver had reached at least one `PairConnected` or `PairPairing`
   state, additionally broadcast `peer_left { reason }` to all remaining
   participants for the convenience cleanup trigger.

### C.5 Contract version

Mesh contract is `v: 2`. Both Go (`signaling/internal/mesh/protocol.go`)
and TS (`frontend/src/features/mesh/signaling/schema.ts`) hard-code
`v == 2`; any other version on `/ws/mesh` ⇒ `error unsupported_version`.

001's `v: 1` continues to live on `/ws` and is not affected by this
contract.

### C.6 Server never relays media

Identical to 001 FR-024 / FR-091. The server's relay path for
`pair_offer` / `pair_answer` / `pair_ice_candidate` / `pair_failed` /
`pair_media_state` does not parse or store SDP / ICE / media-state
bodies. The dedicated `mesh_no_media_relay_test.go` test asserts no
audio / video / screen frame bytes ever appear on the server's I/O.

---

## Part D — Entity ↔ Spec cross-reference

| Entity | Spec sections |
|---|---|
| `MeshRoom`, `ReservedSlot` | FR-011, Key Entities → Mesh Room |
| `Participant`, `Readiness` | FR-013, FR-014, EC-003, Key Entities → Participant |
| `PairId`, `Pair`, `PairState`, `PairAttempt`, `pairEpoch` | FR-021, FR-021a, FR-022, FR-026, Key Entities → Peer-Pair |
| `RosterSnapshot`, `RosterUpdate` | FR-012, FR-012a, FR-012b |
| `LocalParticipant`, `Roster`, `PairContext`, `PairMap` (separation) | FR-013a |
| `Chat`, `ChatFanOut`, FR-052a invariant | FR-050, FR-051, FR-052, FR-052a, FR-053, FR-054, FR-055, US4, SC-006, L17 |
| `MeshCostSnapshot`, sender count `2 × (N − 1)` invariant | FR-070, FR-071, NFR-007, US8, SC-008, L14 |
| `EventEntry` peer/pair scope rule | FR-060, FR-061, FR-062, FR-063, NFR-003 |
| Cleanup paths A/B/C/D | FR-014, FR-025, FR-080..FR-083, EC-005, EC-006, EC-012, US7, SC-005a, SC-005b |
| Contract version + endpoint separation | FR-001..FR-003, FR-090, Constitution Principle II, plan §6 |
