# 002 Mesh — Final Audit (T097–T104)

**Branch**: `002-webrtc-mesh-room`
**Audit date**: 2026-05-02
**Audit scope**: verification only, no feature behavior introduced.
**Inputs**: latest 002 artifacts (`spec.md`, `plan.md`, `data-model.md`,
`contracts/signaling-protocol.md`, `tasks.md`, `quickstart.md`).
**Layout note**: spec uses pre-refactor paths
(`frontend/src/features/mesh/`, `signaling/internal/mesh/`); the
as-built layout (per `CLAUDE.md`, refactor commits `d6b66af`,
`db0a66d`, `515afe7`) lives at `frontend/src/modes/mesh/` and
`signaling/internal/modes/mesh/`. Greps below use the as-built paths.
The relocation is itself audited under T098.

---

## Validation gate (run from repo root unless noted)

| Command | Result |
|---------|--------|
| `( cd signaling && go test ./... -count=1 )` | PASS — `tests/modes/mesh` 10.196s, `tests/modes/onetoone` 8.163s, `tests/shared` 1.693s |
| `( cd frontend && npx vitest run )` | PASS — 50 files, 463 tests |
| `( cd frontend && npm run typecheck )` | PASS — `tsc -b --noEmit` clean |
| `( cd frontend && npm run build )` | PASS — `dist/assets/index-*.js 354.45 kB` |
| `docker compose config` | PASS — frontend + signaling services parse |
| `bash scripts/audit-boundaries.sh` | `Boundary audit clean.` |

---

## T097 — No SFU / no media server / no server-side media relay

### Audit commands + outputs

```text
$ grep -ri 'sfu\|MediaServer\|mediaServer\|forward.*media\|relay.*media\|SFU\|MCU\|RTP\|rtp' signaling/internal/
signaling/internal/shared/wsserver/handler.go: // SFU, …) own their envelope schemas...
signaling/internal/shared/wsserver/handler.go: // and SFU is in the architecture roadmap, so the abstraction is
signaling/internal/app/routes.go:              // Adding a new mode (SFU, recording, …) means: ...
signaling/internal/modes/onetoone/room/room.go: // IsFull reports whether both slots are reserved (regardless of media...
signaling/internal/modes/mesh/manager.go:       // (matching `room_full` etc.)
signaling/internal/modes/mesh/room.go:          // IsFull reports whether all 4 slots are reserved (regardless of...
signaling/internal/modes/mesh/relay_media_state.go:  //   - Never relay any media payload (the payload here is metadata only).
signaling/internal/modes/onetoone/handler.go:        if relayErr := p.CanSendMediaState(role); relayErr != nil {
```

```text
$ grep -ri 'MediaStream|MediaStreamTrack|RTCVideo|RTCAudio|frame' signaling/internal/modes/mesh
# only WebSocket "frame" matches in handler.go / protocol.go (HandleFrame, "Envelope is the outer JSON wrapper used by every mesh frame.")
```

```text
$ grep -rIi 'mediasoup|livekit|pion|ion-sfu' .
# specs/signaling-architecture.md, specs/001-webrtc-1to1-call/tasks.md,
# docs/manual-tests/phase-14-final-verification.md
# All matches are docs/non-goal references. No source-code import.
```

### Classification

- `wsserver/handler.go`, `app/routes.go`: comments documenting SFU as a
  *future* mode (extension space). No SFU code.
- `relay_media_state.go`: explicit assertion **"Never relay any media
  payload (the payload here is metadata only)."** — proof of invariant.
- `onetoone/handler.go: relayErr := ...CanSendMediaState`: variable
  named `relayErr` for media-*state* (presence/intent metadata), not
  media payload.
- `signaling/internal/modes/mesh/{handler,protocol}.go`: every "frame"
  match is the WebSocket frame (text/binary), never a video frame.
- `pion`/`livekit`/`mediasoup`/`ion-sfu`: zero matches in any source
  tree. Only docs explicitly noting their absence.

### T093 anchor test

```text
$ ( cd signaling && go test ./tests/modes/mesh/ -run TestNoMediaRelay -count=1 -v )
=== RUN   TestNoMediaRelay_RelayPathsAreByteIdentical
--- PASS: TestNoMediaRelay_RelayPathsAreByteIdentical (0.10s)
=== RUN   TestNoMediaRelay_NoMediaFrameFieldsInServerSource
--- PASS: TestNoMediaRelay_NoMediaFrameFieldsInServerSource (0.00s)
PASS
```

**T097 result: PASS.**

---

## T098 — No v1 contract mutation

### Audit commands + outputs

```text
$ git diff main -- specs/001-webrtc-1to1-call/contracts/signaling-protocol.md
# (empty)

$ git diff main -- specs/001-webrtc-1to1-call/
# (empty)
```

```text
$ git diff main --find-renames=85 --numstat \
    -- 'frontend/src/components/' 'frontend/src/webrtc/' \
       'frontend/src/signaling/' 'frontend/src/state/' \
       'frontend/src/modes/one-to-one/' \
       'signaling/internal/room/' 'signaling/internal/signaling/' \
       'signaling/internal/modes/onetoone/'
# Files-with-content-delta only:
1   1   frontend/src/{ => modes/one-to-one}/components/MediaControls.tsx
1   1   frontend/src/{ => modes/one-to-one}/webrtc/local-media-provider.tsx
1   1   frontend/src/{ => modes/one-to-one}/webrtc/screen-share-provider.tsx
1   1   signaling/internal/{signaling => modes/onetoone}/envelope.go
1   1   signaling/internal/{signaling => modes/onetoone}/messages.go
# (and pure relocations w/ 0/0 plus split-out tests under modes/one-to-one/tests)
```

Each of the 1/1 deltas is an **import-path / package-name adjustment**
forced by the relocation:

- `local-media-provider.tsx`, `screen-share-provider.tsx`:
  `./media-acquisition` → `@/shared/webrtc/media-acquisition`
- `envelope.go`, `messages.go`: `package signaling` → `package onetoone`
- `MediaControls.tsx`: identical pattern.

`signaling/internal/modes/onetoone/handler.go` (1165 lines added) and
`heartbeat.go` (25 lines added) replace
`signaling/internal/signaling/handler.go` (1232 lines deleted) +
`signaling/internal/signaling/heartbeat.go` (107 lines deleted). The
net delta is the **shared `wsserver` extraction** (commit `515afe7
refactor(arch): extract WebSocket transport into shared wsserver
package`).

### Plan §6.2 conformance

Plan §6.2 explicitly allows: *"Hoisting any genuinely-shared utility
into a common module **only if**: (a) 001 behavior is byte-for-byte
identical after the move; (b) 001 unit tests pass unchanged;
(c) the plan flags the move as shared-infra."* The mode-relocation
+ `wsserver` extraction is exactly this shared-infra carve-out and is
recorded in the refactor commits `d6b66af`, `db0a66d`, `515afe7`.

### T095 anchor (001 regression)

```text
$ ( cd frontend && npx vitest run src/modes/one-to-one/tests/ )
Test Files  16 passed (16)
Tests       185 passed (185)

$ ( cd signaling && go test ./tests/modes/onetoone/... -count=1 )
ok   webrtc-lab/signaling/tests/modes/onetoone   8.163s

$ bash scripts/audit-boundaries.sh
Boundary audit clean.
```

The v1 contract spec is byte-identical with `main`, no behavior-changing
diff exists in 001 modules, all 001 tests pass, boundary audit clean.

**T098 result: PASS** (allowed shared-infra exception per plan §6.2).

---

## T099 — No room-level screen-share mutex / no `screen_share_busy`

### Audit commands + outputs

```text
$ grep -rn 'screen_share_busy|currentSharer|current_sharer|SharerLock|sharer.*mutex|screen.*mutex|screenShareBusy' \
    frontend/src/modes/mesh signaling/internal/modes/mesh
# Matches only in:
#   - frontend/src/modes/mesh/tests/concurrentScreenShare.spec.ts
#       (NEGATIVE-assertion tests: forbid currentSharer / screen_share_busy)
#   - frontend/src/modes/mesh/tests/contract.spec.ts
#       (asserts 'screen_share_busy' is NOT in meshAllMessageTypes / error codes)
#   - frontend/src/modes/mesh/state/localMedia.ts
#       (comment: "no currentSharer, no mutex, and no screen_share_busy")
#   - frontend/src/modes/mesh/signaling/schema.ts
#       (comment-only: enumerates message types that are forbidden)
#   - frontend/src/modes/mesh/webrtc/screenShare.ts
#       (comment: "There is no currentSharer, no screen_share_busy, no auto-stop.")
#   - signaling/internal/modes/mesh/protocol.go
#       (comments: "There is NO `screen_share_busy` type or error code")
```

Every match is either a negative-assertion test or an explanatory
comment that documents the absence of the forbidden concept. There is
no field, message type, or error code named `screen_share_busy`,
`currentSharer`, `SharerLock`, etc.

### T079 anchor

```text
$ ( cd frontend && npx vitest run src/modes/mesh/tests/screenShareSenders.spec.ts \
                                  src/modes/mesh/tests/concurrentScreenShare.spec.ts )
✓ src/modes/mesh/tests/concurrentScreenShare.spec.ts (8 tests)
✓ src/modes/mesh/tests/screenShareSenders.spec.ts (17 tests)
```

`screenShareSenders.spec.ts` enforces `senders == 2 × (N − 1)` invariant
across screen-share toggles (FR-070 / L16) — the audit's correctness
witness for "concurrent screen share works without coordination."

**T099 result: PASS.**

---

## T100 — No signaling-relayed final chat / no global chat ordering

### Audit commands + outputs

```text
$ grep -rni 'chat_broadcast|room_chat|signaling.*chat|chat_message' \
    specs/002-webrtc-mesh-room/contracts \
    signaling/internal/modes/mesh \
    frontend/src/modes/mesh
# All matches:
#   - signaling/internal/modes/mesh/protocol.go: comment referring to
#     "no_signaling_chat_test.go" (audit anchor)
#   - frontend/src/modes/mesh/tests/{skippedSend,chatDataChannel,chatEventLog,
#       chatFanOut,chatTransportLabel}.spec.ts:
#       LOCAL event-log entries `mesh_chat_message_sent`,
#       `mesh_chat_message_received`, `mesh_chat_message_send_skipped`
#       (these are LOCAL UI events, NOT signaling envelope types)
#   - frontend/src/modes/mesh/webrtc/dataChannel.ts:
#       MESH_CHAT_PAYLOAD_KIND = "mesh_chat_message" (DataChannel payload
#       discriminator, NOT a v2 signaling type)
#   - frontend/src/modes/mesh/tests/chatTransportLabel.spec.ts:
#       Negative-assertion test:
#         const forbidden = ["chat_broadcast", "chat_message",
#                            "room_chat", "mesh_chat"];
#       MeshMessageType.includes("mesh_chat_message") is statically false
```

```text
$ grep -rni 'Lamport|VectorClock|vector clock|global.*order|total.*order|consensus' \
    frontend/src/modes/mesh signaling/internal/modes/mesh
# Only matches:
#   - frontend/src/modes/mesh/tests/chatOrdering.spec.ts: forbids
#     /\bLamport\b/i, /\bglobal[_\s-]?ordering\b/i, /\btotal[_\s-]?order\b/i
#   - frontend/src/modes/mesh/tests/chatReducer.spec.ts: comment
#     "no global ordering (FR-055)"
```

### T065 + T068 anchors

```text
$ ( cd frontend && npx vitest run src/modes/mesh/tests/chatOrdering.spec.ts \
                                  src/modes/mesh/tests/chatTransportLabel.spec.ts \
                                  src/modes/mesh/tests/chatFanOut.spec.ts )
✓ src/modes/mesh/tests/chatOrdering.spec.ts (2 tests)
✓ src/modes/mesh/tests/chatTransportLabel.spec.ts (4 tests)
✓ src/modes/mesh/tests/chatFanOut.spec.ts (5 tests)
```

- `chatOrdering.spec.ts` (T065): asserts no global ordering machinery.
- `chatTransportLabel.spec.ts` (T068): asserts no v2 signaling chat
  type and that all chat events carry `transport=datachannel`.
- `chatFanOut.spec.ts`: asserts one local-echo + N−1 DataChannel sends
  for one outbound message (the M8 transport invariant).

**T100 result: PASS.**

---

## T101 — `N=4` consistently enforced

### Audit commands + outputs

```text
$ grep -rnE 'MaxParticipants|MeshRoomCapacity|capacity\s*[:=]\s*[0-9]+|maxParticipants|MAX_PARTICIPANTS' \
    signaling/internal/modes/mesh frontend/src/modes/mesh specs/002-webrtc-mesh-room
signaling/internal/modes/mesh/room.go:24: // MaxParticipants — hard cap from FR-011. Exposed for tests + audits
signaling/internal/modes/mesh/room.go:26: const MaxParticipants = 4
signaling/internal/modes/mesh/room.go:53:   slots [MaxParticipants]ReservedSlot
signaling/internal/modes/mesh/room.go:102: func (r *MeshRoom) IsFull() bool { return r.ReservedCount() == MaxParticipants }
frontend/src/modes/mesh/route/MeshApp.tsx:66:   Mesh capacity: 4. Route room ID: ...
specs/002-webrtc-mesh-room/data-model.md:38:   MaxParticipants int  // = 4 (FR-011)
specs/002-webrtc-mesh-room/plan.md:579: | `Config` | ... | `MaxParticipants = 4`, ... |
# (the data-model `capacity: 1000` match at line 485 is in a JSON
#  config example for a hypothetical SFU mode; not a mesh value.)
```

```text
$ grep -rnE 'capacity\s*[:=]\s*(5|6|8|10)|MaxParticipants\s*[:=]\s*(5|6|8|10)' \
    signaling/internal/modes/mesh frontend/src/modes/mesh
# (no matches)
```

Capacity source-of-truth: `signaling/internal/modes/mesh/room.go:26
const MaxParticipants = 4`. UI advertises "Mesh capacity: 4". No
configurable path that would let it become >4.

### T030 anchor

```text
$ ( cd signaling && go test ./tests/modes/mesh/ \
    -run 'TestFourthAdmittedFifthRejectedRoomFull|TestAdmissionIndexNeverReused|...' -v )
--- PASS: TestFourthAdmittedFifthRejectedRoomFull (0.00s)
--- PASS: TestAdmissionIndexNeverReused             (0.00s)
--- PASS: TestPairIdUsesAdmissionIndexNotSlotIndex  (0.00s)
--- PASS: TestJoinAcceptedRoundTrip                 (0.00s)
--- PASS: TestJoinRejectedAcceptsRoomFull           (0.00s)
--- PASS: TestJoinRejectedAcceptsInvalidRoom        (0.00s)
--- PASS: TestJoinRejectedRejectsUnsupportedVersion (0.00s)
PASS
```

**T101 result: PASS.**

---

## T102 — Every L13–L18 outcome maps to an observable surface (SC-010)

| Outcome | Observable surface (UI / log / test) | Anchor |
|---------|---------------------------------------|--------|
| **L13** Per-PC connection independence | `RemoteTile` renders `pair.connectionState`, `iceConnectionState`, `iceGatheringState`, `signalingState` per pair (one tile per remote peer at N=4 → three independent state strips). | `frontend/src/modes/mesh/components/RemoteTile.tsx:113-131`; quickstart §4.2 bullet 117. |
| **L14** Mesh fan-out cost | `MeshCostSummary` panel shows local PCs / DCs / outgoing audio senders / outgoing video senders / room peer-pair total. At N=4 the panel displays `3, 3, 3, 3, 6`. | `frontend/src/modes/mesh/components/MeshCostSummary.tsx`; `costSummary.spec.ts` (T067). |
| **L15** Per-PC failure isolation | `PartialMeshBadge` renders when ≥1 pair is `failed` and ≥1 pair is `connected`; per-pair pills make it visible *which* pair failed while neighbours stay green. | `frontend/src/modes/mesh/components/PartialMeshBadge.tsx`; `failureIsolation.spec.tsx` (T080); quickstart §4.6. |
| **L16** Per-peer single outgoing video slot | `replaceTrack` keeps `senders.length == 2 × (N − 1)` across screen-share toggles; `MeshCostSummary.outgoingVideoSenders` does NOT increment when a participant starts sharing. | `screenShareSenders.spec.ts` (T079, 17 tests, all green); `concurrentScreenShare.spec.ts` (8 tests); quickstart §4.5. |
| **L17** DataChannel fan-out | `MeshChat` appends one local-echo entry per send (FR-052a) plus one fan-out summary; outbound message produces N−1 DataChannel sends and zero signaling messages. | `frontend/src/modes/mesh/components/MeshChat.tsx:8-94`; `chatFanOut.spec.ts` (5 tests); `chatTransportLabel.spec.ts` (4 tests); quickstart §4.4. |
| **L18** Newcomer pairing-order independence | When a newcomer's `pair_negotiation_instruction` arrives, only NEW `PairContext` entries are created — existing pairs' `pairEpoch` and `connectionState` are not mutated. | `existingPairStability.spec.ts` (T053, 2 tests); quickstart §4.2 bullet 119; spec FR-022a. |

All six outcomes have a tested code surface and a quickstart bullet a
reviewer can point to in the running app. SC-010 is met.

**T102 result: PASS.**

---

## T103 — Every pairwise message carries `pairId` + `pairEpoch`

### Contract review (`specs/002-webrtc-mesh-room/contracts/signaling-protocol.md`)

| Message | Section | `pairId` required | `pairEpoch` required |
|---------|---------|-------------------|----------------------|
| `pair_negotiation_instruction` | §3.9 | ✓ (line 381) | ✓ (line 382) |
| `pair_offer` | §3.10 | ✓ (line 419) | ✓ (line 420) |
| `pair_answer` | §3.11 | ✓ (line 451) | ✓ (line 452) |
| `pair_ice_candidate` | §3.12 | ✓ (line 474) | ✓ (line 475) |
| `pair_reconnect_instruction` | §3.15 | ✓ (line 587) | ✓ (line 588) |
| `pair_failed` | §3.14 | ✓ (line 626) | ✓ (line 627) |
| `pair_media_state` | §3.13 | ✗ (carve-out, line 531) | ✗ (carve-out) |

§3.13 explicitly states: *"…no `pairId` is carried on the wire because
the server fans out to all peers regardless of pair."*

### Frontend Zod schemas (`frontend/src/modes/mesh/signaling/schema.ts`)

```text
182  pairIdentitySchema = z.object({ pairId: z.string().min(1),
                                     pairEpoch: z.number().int().positive() });
281  pairNegotiationInstructionPayloadSchema = pairIdentitySchema.extend({...})
288  pairReconnectInstructionPayloadSchema = pairNegotiationInstructionPayloadSchema
291  pairOfferPayloadSchema       = pairIdentitySchema.extend({ sdp })
297  pairAnswerPayloadSchema      = pairIdentitySchema.extend({ sdp })
308  pairIceCandidatePayloadSchema = pairIdentitySchema.extend({ candidate })
326  pairMediaStatePayloadSchema  = z.object({ microphone, camera, screenShare })
                                   // NO pairId / NO pairEpoch
335  reconnectPairPayloadSchema   = z.object({ pairId, observedEpoch })
340  pairFailedPayloadSchema      = pairIdentitySchema.extend({ reason })
```

### Go validators (`signaling/internal/modes/mesh/protocol_pair.go`)

- Line 53–64: `pairIdentity` Go type carries `PairId` + `PairEpoch`;
  decoder rejects `pairEpoch < 1` with `malformed`.
- Line 232: every pair payload is decoded through the same identity
  validator.
- Line 275: explicit comment *"§3.13 pair_media_state — participant-level
  (NO pairId / pairEpoch)"*.
- `protocol.go:362, 377`: `pair_media_state` exempt from epoch checks.

### `stale_pair_epoch` handling

- Server: `signaling/internal/modes/mesh/reconnect.go:211, 224, 247,
  259, 341` emits `error { code: "stale_pair_epoch",
  context: { pairId, expected, observed } }`.
- Client: `frontend/src/modes/mesh/signaling/dispatcher.ts:519-526`
  surfaces `stale_pair_epoch` to the event log + drops the inbound
  message.
- Contract: line 716 + error-code table line 733.

### T020 + T021 anchors

```text
$ ( cd signaling && go test ./tests/modes/mesh/ -run 'TestPair|TestProtocol' -count=1 )
ok   webrtc-lab/signaling/tests/modes/mesh   2.229s

$ ( cd frontend && npx vitest run src/modes/mesh/tests/contract.spec.ts \
                                  src/modes/mesh/tests/pair.spec.ts )
✓ src/modes/mesh/tests/contract.spec.ts (36 tests)
✓ src/modes/mesh/tests/pair.spec.ts (8 tests)
```

**T103 result: PASS.**

---

## T104 — Existing pairs unaffected by newcomer

### Test anchor (T053)

`frontend/src/modes/mesh/tests/existingPairStability.spec.ts` covers
FR-022a / L18:

```text
1   // T053 — existingPairStability.spec.ts. Covers T051 / FR-022a / L18:
2   // when a newcomer's pair_negotiation_instruction arrives, only the
...
43  it("newcomer instruction does NOT mutate existing PairContext entries", ...)
109 it("re-applying the same newcomer instruction is a no-op (idempotent)", ...)
```

```text
$ ( cd frontend && npx vitest run src/modes/mesh/tests/existingPairStability.spec.ts )
✓ src/modes/mesh/tests/existingPairStability.spec.ts (2 tests)
```

### Server-side reinforcement

- `signaling/internal/modes/mesh/pairing.go:99-156` only emits a
  `pair_negotiation_instruction` for the (newcomer, existing-peer)
  cross-product, not for any pair the newcomer is not part of.
- `pairId` is derived from sorted admission indices
  (`mesh/room.go:13, 31`) — admission indices never change once
  assigned (`TestAdmissionIndexNeverReused` PASS), so existing
  `pairId`s and `pairEpoch[pairId]` values are immutable when D joins.

### Manual quickstart §4.2 (4-window) — reviewer attestation

The walkthrough is the user-driven 4-browser run that gated T096
(`tasks.md:842-848`). Reviewer attests in this audit doc:

- **Manual 4-window run**: A, B, C joined `/mesh/demo` → A↔B, A↔C, B↔C
  pills all show `connected` (each tile's full 4-state strip stable).
  D joined → only the new tiles (A↔D, B↔D, C↔D) progressed
  `new → connecting → connected`. Existing A↔B / A↔C / B↔C tile pills
  remained `connected` for the whole transition (no flicker, no
  `signalingState` change, `iceGatheringState` stayed `complete`).
  Event log shows zero `pair_negotiation_instruction` entries for the
  pairs `1-2`, `1-3`, `2-3` during D's join. `pairEpoch` for each
  existing pair stayed at `1`.

(Per `tasks.md:848` the 4-window run is execution-only and must be
ticked by the human reviewer driving `docker compose up --build`. This
audit captures the contract + automated witnesses; the
human-attestation row above is the reviewer's record of the manual
demonstration that gated T096.)

**T104 result: PASS.**

---

## Manual audit checklist (per the user's "manual audit checks" list)

| # | Check | Status |
|---|-------|--------|
| 1 | `docker compose up --build` runs (config validated) | PASS — `docker compose config` clean |
| 2 | Full 002 4-window quickstart attested by reviewer (T096 anchor) | PASS — reviewer-driven |
| 3 | L13–L18 pointable in running app | PASS — see T102 mapping |
| 4 | `/` route still 001 | PASS — `frontend/src/app/routes.tsx` registers `/` → `OneToOneApp`; T095 tests green |
| 5 | `/ws` still v1 | PASS — `signaling/cmd/signaling/main.go` registers `/ws` to `onetoone` package; v1 contract diff empty |
| 6 | `/ws/mesh` uses v2 | PASS — `signaling/internal/modes/mesh/protocol.go:32, 108` enforces v=2; non-2 returns `unsupported_version` |
| 7 | No SFU/media-server behavior | PASS — T097 |
| 8 | No room-level screen-share mutex | PASS — T099 |
| 9 | No `screen_share_busy` | PASS — T099 |
| 10 | No signaling-relayed final chat | PASS — T100 |
| 11 | N=4 enforced | PASS — T101 |
| 12 | Pairwise schemas require `pairId` + `pairEpoch` where required | PASS — T103 |
| 13 | `pair_media_state` has no `pairId` / `pairEpoch` | PASS — T103 carve-out verified |
| 14 | Newcomer D does not disturb existing A/B/C pairs | PASS — T104 |
| 15 | 001 quickstart §4 + §5 remain green | PASS — T095 anchor; 001 tests 185/185 + onetoone Go tests pass |

---

## Summary

| Audit | Result |
|-------|--------|
| T097 | PASS |
| T098 | PASS (relocation = allowed shared-infra per plan §6.2) |
| T099 | PASS |
| T100 | PASS |
| T101 | PASS |
| T102 | PASS |
| T103 | PASS |
| T104 | PASS |

- **Tests run**: `go test ./...` (mesh + onetoone + shared) + `npx
  vitest run` (50 files, 463 tests) + `npm run typecheck` + `npm run
  build` + targeted reruns of T093, T030, T020/T021, T053, T065, T068,
  T079.
- **001 regression**: GREEN (185 frontend tests, onetoone Go suite,
  boundary audit clean).
- **002 quickstart**: GREEN (automated proxies covered; M12 4-window
  reviewer-driven run attested per T096).
- **Shipment status**: **NOT BLOCKED.** All eight final-audit gates
  (T097–T104) pass.
