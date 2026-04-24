# `docs/` — index

Reader-oriented docs for the **1:1 WebRTC Learning Call** (branch
`001-webrtc-1to1-call`). Engineering specs and tasks live separately
under [`../specs/001-webrtc-1to1-call/`](../specs/001-webrtc-1to1-call/);
these docs are for learning the system and running it.

## Reading order

1. **[`learning/01-webrtc-primer.md`](./learning/01-webrtc-primer.md)** —
   start here if WebRTC is new to you. Zero prior knowledge assumed.
   Covers STUN, TURN, ICE, SDP, DTLS, SRTP, SCTP, codecs, and why any
   of it exists.
2. **[`learning/02-app-walkthrough.md`](./learning/02-app-walkthrough.md)** —
   the happy-path call, stage by stage, tied to real files and Event
   Log entries in this repo. Assumes the primer's vocabulary.
3. **[`manual-tests/two-browser-test.md`](./manual-tests/two-browser-test.md)** —
   scripted reproduction plan: two physical devices on one LAN, every
   manual check from environment setup to `T-09` ungraceful
   disconnect.

## Directory layout

```
docs/
├── README.md                         — this file
├── learning/                         — conceptual / educational
│   ├── 01-webrtc-primer.md           — what the acronyms mean (generic)
│   └── 02-app-walkthrough.md         — how this app wires them up (specific)
└── manual-tests/                     — scripted verification runs
    └── two-browser-test.md           — Phases 0–9 two-device checklist
```

## What belongs where (for future additions)

- **`learning/`** — conceptual explanation, tutorials, architecture
  overviews aimed at humans building a mental model. Numeric prefixes
  (`01-`, `02-`, …) indicate reading order.
- **`manual-tests/`** — step-by-step human-run verification scripts.
  One file per scenario; add more as new phases ship.
- Engineering specs (contracts, data models, phase plans) belong in
  [`../specs/`](../specs/), not here. Docs in this tree reference
  them but don't duplicate them.

## Related, outside this directory

- [`../specs/001-webrtc-1to1-call/spec.md`](../specs/001-webrtc-1to1-call/spec.md) — feature spec.
- [`../specs/001-webrtc-1to1-call/plan.md`](../specs/001-webrtc-1to1-call/plan.md) — phased implementation plan.
- [`../specs/001-webrtc-1to1-call/contracts/signaling-protocol.md`](../specs/001-webrtc-1to1-call/contracts/signaling-protocol.md) — wire-level signaling contract.
- [`../specs/001-webrtc-1to1-call/data-model.md`](../specs/001-webrtc-1to1-call/data-model.md) — reducer + domain model.
- [`../specs/001-webrtc-1to1-call/research.md`](../specs/001-webrtc-1to1-call/research.md) — design research behind those choices.
- [`../specs/001-webrtc-1to1-call/quickstart.md`](../specs/001-webrtc-1to1-call/quickstart.md) — the original quickstart + full-feature checklist.
