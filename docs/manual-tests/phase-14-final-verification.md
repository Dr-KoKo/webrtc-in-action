# Phase 14 — Final Verification Log

**Feature**: 1:1 WebRTC Learning Call (`001-webrtc-1to1-call`).
**Scope**: MVP exit gate for tasks T095–T102.
**Date**: 2026-04-25.
**Branch tip**: `7d69fc4` (Phase 13 exit + review nits) — plus the
verification-log + `tasks.md` T101 methodology refinement committed
in this phase.

This log is the single evidence file for Phase 14 per the plan's
"Phase 14 exit criterion". It records the test-gate runs (T097), the
three audits (T098/T099/T100), the NFR-003 log audit (T101), the
README + quickstart polish (T102), and the happy-path / failure-path
manual verification templates (T095 / T096) — deferred with resume
recipes where a human is required. Do not duplicate the two-browser
manual test in `docs/manual-tests/two-browser-test.md`; this file
references it where relevant.

---

## T097 — Unit-test gate

All three suites green on the Phase 13 tip; no `frontend/src/`,
`signaling/internal/`, or `signaling/cmd/signaling/` changes since
Phase 12.

### frontend — `npx vitest run`

```
 Test Files  16 passed (16)
      Tests  185 passed (185)
   Duration  1.45s
```

Matches the Phase 12 baseline of 185/185.

### frontend — `npx tsc --noEmit`

Exit 0, no output.

### signaling — `go test ./...`

```
?   	webrtc-lab/signaling/cmd/healthprobe	[no test files]
?   	webrtc-lab/signaling/cmd/signaling	[no test files]
?   	webrtc-lab/signaling/internal/logging	[no test files]
?   	webrtc-lab/signaling/internal/room	[no test files]
?   	webrtc-lab/signaling/internal/signaling	[no test files]
ok  	webrtc-lab/signaling/tests	(cached)
```

### Playwright (optional, deferred)

Deferred this run. Reason: the three compiled gates above cover
every `frontend/src/` behavior Phase 14 asserts, and a dedicated
Playwright pass would only re-cover what the existing 7 scenarios
already assert (see `frontend/tests/e2e/COVERAGE.md`). Resume recipe:

```bash
docker compose -f docker-compose.dev.yml --env-file .env.dev \
  up -d --build --force-recreate
cd frontend && npx playwright test   # expect 7 / 7 per COVERAGE.md
docker compose -f docker-compose.dev.yml down
```

---

## T098 — Contract §3 conformance audit

Canonical source: [`../../specs/001-webrtc-1to1-call/contracts/signaling-protocol.md`](../../specs/001-webrtc-1to1-call/contracts/signaling-protocol.md).

Every §3.1–§3.15 message type and every `payload.result` / `reason`
enum value appears in both codebases. Row-level evidence:

| §  | Type | `frontend/src/signaling/schema.ts` | `signaling/internal/signaling/envelope.go` + `messages.go` | `handler.go` dispatch/emit | `frontend/src/signaling/dispatcher.ts` |
|----|------|---|---|---|---|
| 3.1  | `join_room`            | L166 `z.literal("join_room")`            | envelope.go L31 `TypeJoinRoom`            | L242 case + inbound handler                 | L238 case (C→S mirror guard) |
| 3.2  | `join_accepted`        | L176                                     | envelope.go L32                           | L258, L340 emit                             | L85 case |
| 3.3  | `join_rejected`        | L201                                     | envelope.go L33                           | L258, L589 emit                             | L102 case |
| 3.4  | `peer_presence_changed`| L215                                     | envelope.go L34                           | L501, L560 emit                             | L123 case |
| 3.5  | `media_ready`          | L229                                     | envelope.go L35                           | L246 case                                   | L208 case |
| 3.6  | `media_failed`         | L247                                     | envelope.go L36                           | L248 case                                   | L209 case |
| 3.7  | `ready_for_offer`      | L259                                     | envelope.go L37                           | L258, L850 emit                             | L179 case |
| 3.8  | `offer`                | L276                                     | envelope.go L38                           | L250 case → `handleSDPRelay(TypeOffer)` L888| L180 case |
| 3.9  | `answer`               | L287                                     | envelope.go L39                           | L252 case → `handleSDPRelay(TypeAnswer)` L893| L181 case |
| 3.10 | `ice_candidate`        | L298                                     | envelope.go L40                           | L254 case + L1090 relay                     | L182 case |
| 3.11 | `media_state`          | L309                                     | envelope.go L41                           | L256 case + L1202 relay                     | L184 case |
| 3.12 | `peer_left`            | L322                                     | envelope.go L42                           | L522 emit                                   | L210 case |
| 3.13 | `participant_released` | L339                                     | envelope.go L43                           | L792 emit                                   | L150 case |
| 3.14 | `leave_room`           | L352                                     | envelope.go L44                           | L244 case                                   | L211 case |
| 3.15 | `error`                | L373                                     | envelope.go L45                           | L266 case + L606 emit                       | L222 case |

`payload.result` / `payload.reason` enum values (§3.3, §3.12, §3.13):

| Value | `schema.ts` | `messages.go` |
|---|---|---|
| `join_rejected_room_full`           | L196 | L95  (`JoinRejectedRoomFull`) |
| `join_rejected_invalid_room`        | L197 | L96  (`JoinRejectedInvalidRoom`) |
| `participant_released_media_failed` | L334 | L140 (`ParticipantReleasedMediaFailed`) |
| `participant_released_disconnect`   | L335 | L141 (`ParticipantReleasedDisconnect`) |
| `peer_left.reason = "graceful_leave"` | L325 | L161 (`PeerLeftGracefulLeave`) |
| `peer_left.reason = "disconnect"`     | L325 | L162 (`PeerLeftDisconnect`) |

No rows missing. §3.16 ("WebSocket-level Ping/Pong") is a control-frame
concern, not a JSON message type, and is covered by T085 /
`heartbeat_test.go` rather than the schema.

---

## T099 — Stale-message-type audit

The four legacy names `room_full`, `peer_joined`, `peer_state_changed`,
`participant_released_media_failed` are forbidden as `type` envelope
values. Payload occurrences are legal (contract §3.3 / §3.13).

### Type-field literal grep

```
rg -n '"type"\s*:\s*"(room_full|peer_joined|peer_state_changed|participant_released_media_failed)"' \
   frontend/src signaling/cmd signaling/internal
```

Exit `1` — zero hits.

### Bare-word grep across runtime code

```
rg -nw '(room_full|peer_joined|peer_state_changed|participant_released_media_failed)' \
   frontend/src/signaling signaling/internal/signaling
```

Exit `0`, with all hits annotated and allowed:

| Hit | File | Nature |
|---|---|---|
| `frontend/src/signaling/schema.ts:17–18` | comment citing the forbidden names | explanatory doc, not runtime |
| `frontend/src/signaling/schema.ts:205` | `z.enum(["room_full","invalid_room_id"])` | payload `reason` enum for `join_rejected` (§3.3) |
| `frontend/src/signaling/schema.ts:334` | `"participant_released_media_failed"` | payload `result` enum for `participant_released` (§3.13) |
| `signaling/internal/signaling/envelope.go:24–25` | comment explaining the forbidden names | explanatory doc, not runtime |
| `signaling/internal/signaling/messages.go:102` | `ReasonRoomFull JoinRejectedReason = "room_full"` | payload enum (§3.3) |
| `signaling/internal/signaling/messages.go:140` | `ParticipantReleasedMediaFailed ParticipantReleasedResult = "participant_released_media_failed"` | payload enum (§3.13) |

No forbidden name leaks into the `type` discriminator on either side.

---

## T100 — Media-relay audit (Principle III)

**Summary.** The signaling server never parses, mutates, caches, or
reinjects SDP / ICE / `media_state` payload content. `offer` and
`answer` route through `handleSDPRelay` (`handler.go:904`), which
forwards `d.Envelope.Payload` — a `json.RawMessage` captured by
`DecodeEnvelope` BEFORE payload decoding — onto a freshly-minted
envelope whose only mutated fields are `From` (sender `peerId`), `To`
(remote `peerId`), `Type` (echoed), and `TS` (server time). The
inline comment at `handler.go:897–904` makes this explicit: "the
server NEVER parses `payload.sdp.sdp` — the inbound payload bytes are
forwarded verbatim". `ice_candidate` relay (`handler.go:1080–1100`)
and `media_state` relay (`handler.go:1180–1210`) follow the same
pattern against the same captured raw bytes. The only non-validator
touch of `.Candidate` is a nil-vs-non-nil check at `handler.go:1117`
/ `:1123` to derive a boolean `end_of_candidates` log field; the
candidate string content itself is never read there (the comment at
`handler.go:1117` justifies the access). No `json.Unmarshal` call
exists anywhere in `handler.go`. No Go WebRTC library is imported
(`rg 'pion' signaling/` → zero hits; `rg 'webrtc' signaling/` hits
only the project's own `webrtc-lab/signaling/...` module paths). The
server is a pure-relay for §3.8–§3.11.

### Grep evidence

```
rg -n '\.SDP|\.Candidate' signaling/internal/signaling
```

- `messages.go` L369 / L372 / L383 / L386 — validators on
  `p.SDP.Type` (must equal `"offer"` / `"answer"`) and `p.SDP.SDP`
  (non-empty guard). Allowed: in-messages.go validators per T100 DoD.
- `messages.go` L433 / L440 / L448 / L451 — validators on
  `p.Candidate` nil-form + empty-string rejection. Allowed: same.
- `handler.go` L1117 / L1123 — nil check on `payload.Candidate`
  to surface `end_of_candidates` as a log boolean. Justified: the
  comment at L1117 states the purpose and explicitly does NOT
  re-parse the raw body; the only alternative would be to re-run
  the decoder on `d.Envelope.Payload`, which would be a net regression
  for NFR-003 (reading body bytes unnecessarily).

```
rg -n 'regexp.*(sdp|candidate)|strings\.(Contains|Index).*(sdp|candidate)' signaling/
```

- One hit: `signaling/tests/protocol_flow_test.go:1216` —
  `strings.Contains(logs, "\"event\":\"ice_candidate_relay\"")`.
  Test-only, asserts an event-name string, not payload content.

```
rg -n 'json\.Unmarshal' signaling/internal/signaling/handler.go
```

Exit `1` — zero hits.

---

## T101 — NFR-003 log audit

**Methodology note.** The original T101 recipe grepped the signaling
logs case-insensitively for the three substrings `sdp`, `candidate:`,
and `credential`. That substring grep false-positives on the server's
structured event-name metadata — `event:"sdp_relay"` and the
companion `msg:"sdp relayed"` log lines (introduced in Phase 4 /
commit `730609b`, `handler.go:1009–1010`). Those tags announce
*that* an SDP relay happened for operator debugging and carry only
`type` (offer/answer), `from_peer_id`, and `to_peer_id` — no SDP body,
no ICE candidate string, no credential. NFR-003's actual subject is
payload *content* (SDP bodies, raw ICE candidate strings, TURN
credentials), not observability-event tag names. The recipe was
refined (see `tasks.md` T101 — this commit) to three
content-pattern greps that match the categories NFR-003 names. The
pre-refinement two hits are quoted verbatim below for transparency
and are not a violation. See also the `tasks.md` `Notes` reminder
that "Signaling logs must never contain SDP / ICE / TURN credentials
(NFR-003) — guarded by T101" — the refined recipe makes that guard
detect only the actual leakage shape rather than any occurrence of
the substring `"sdp"`.

### Traffic run

- Stack: `docker compose up -d --build` against the prod compose
  file (distroless signaling, `LOG_FORMAT=json`, `LOG_LEVEL=info`).
  Signaling healthcheck reached `Healthy`.
- Traffic generator: a throwaway Node 24 script at
  `/tmp/phase14-traffic.mjs` (not committed) opens two WS peers
  directly against `ws://localhost:8080/ws`, drives a full happy-
  path protocol sequence (`join_room` × 2 → `media_ready` × 2 →
  `ready_for_offer` × 2 → `offer` → `answer` → `ice_candidate` × 3
  each + end-of-candidates × 2 → `media_state`), soaks for 65 s so
  the heartbeat ping/pong cycle exercises (interval 5 s, timeout
  5 s), then sends `leave_room` from each side and closes both
  connections.
- Observed window: **67 seconds** start-to-end.
- Log capture: `docker compose logs signaling > /tmp/phase-14-logs.txt`
  produced **21 log lines** total.

Resume recipe (if this run needs to be repeated):

```bash
docker compose up -d --build
# wait for `docker compose ps` to show signaling Healthy
node /tmp/phase14-traffic.mjs        # or an equivalent WS client
docker compose logs signaling > /tmp/phase-14-logs.txt
docker compose down
```

### Refined content-pattern greps (all three MUST be zero hits)

```
# (1) SDP body tokens
rg -n -i 'v=0|m=audio|m=video|m=application|a=ice-ufrag|a=ice-pwd|a=setup:|a=fingerprint:|a=sctp-port|a=mid:' /tmp/phase-14-logs.txt
```

Exit `1`. Zero hits.

```
# (2) ICE candidate body
rg -n -i 'candidate:[0-9]+ [0-9]+' /tmp/phase-14-logs.txt
```

Exit `1`. Zero hits.

```
# (3) TURN credentials
rg -n -i '"credential"\s*:|credential=|password=|turn[s]?://[^@/]+@' /tmp/phase-14-logs.txt
```

Exit `1`. Zero hits.

**Result: T101 PASS.** NFR-003 holds — the signaling server does not
log SDP bodies, ICE candidate strings, or TURN credentials during a
full happy-path + heartbeat-soak window.

### Pre-refinement hits, annotated (for the record)

The original literal `rg -n -i 'sdp|candidate:|credential'` grep
returned exit `0` with two hits, both on the same structured event
tag. Both carry zero payload content — only event name, message type
enum (`offer` / `answer`), and the two peer IDs:

```
9:signaling-1  | {"time":"…","level":"INFO","msg":"sdp relayed","event":"sdp_relay","type":"offer","from_peer_id":"e075d7b3-…","to_peer_id":"c681957a-…"}
10:signaling-1 | {"time":"…","level":"INFO","msg":"sdp relayed","event":"sdp_relay","type":"answer","from_peer_id":"c681957a-…","to_peer_id":"e075d7b3-…"}
```

Verdict: **metadata, not content.** Pre-existing since Phase 4
(`handler.go:1009–1010`, commit `730609b`). No rename of
`sdp_relay` / `ice_candidate_relay` / `media_state_relay` is
performed in Phase 14 — those tags are load-bearing for operator
debugging, and the grep (not the runtime) was the defect.

### Optional future hardening (not required, not a Phase 14 blocker)

A Go-level test (e.g. `signaling/tests/nfr003_log_audit_test.go`)
could install a capturing `slog.Handler` during a synthetic
offer / answer / ice_candidate exchange and run the same three
content-pattern greps programmatically, locking NFR-003 into CI
without re-running compose. Deferred — file under a future feature
spec if appetite arises.

---

