<!-- SPECKIT START -->
This repo is a multi-mode WebRTC playground. Each WebRTC topology is a
self-contained **mode**; the app shell only chooses one. Read
`specs/architecture.md` first — it documents the per-mode layout,
boundary rules, and "adding a new mode" checklist.

Active feature: **SFU Learning Room** on branch
`003-webrtc-sfu-room`. SFU is **additive** alongside the preserved
001 1:1 codepath and the preserved 002 mesh codepath; both 001 and
002 specs, contracts, and behavior remain frozen (regression-only).
The active plan is `specs/003-webrtc-sfu-room/plan.md`.

Layout:

- Frontend modes: `frontend/src/modes/{one-to-one,mesh,sfu}/`.
- Frontend shared: `frontend/src/shared/` (cross-mode primitives only).
- Frontend app shell: `frontend/src/app/{App,routes,ModeBadge,modes}.tsx`.
- Backend modes: `signaling/internal/modes/{onetoone,mesh,sfu}/` (sfu also has `mediafabric/`).
- Backend shared: `signaling/internal/shared/{logging,heartbeat,config,wsserver}/`.
- Backend tests: `signaling/tests/modes/{onetoone,mesh,sfu}/`.
- Boundary audit: `scripts/audit-boundaries.sh` (FRONT_MODES + BACK_MODES include `sfu`).

Per-version specs (immutable historical records):

- Architecture rules: `specs/architecture.md` + `specs/signaling-architecture.md` + `specs/frontend-architecture.md`
- 003 SFU: `specs/003-webrtc-sfu-room/{spec,plan,research,data-model,quickstart,checklists/}.md` + `contracts/signaling-protocol.md`
- 002 mesh (frozen, do NOT edit): `specs/002-webrtc-mesh-room/{spec,plan,data-model,quickstart}.md` + `contracts/signaling-protocol.md`
- 001 1:1 (frozen, do NOT edit): `specs/001-webrtc-1to1-call/{plan,quickstart}.md` + `contracts/signaling-protocol.md`

Constitution: `.specify/memory/constitution.md` (v2.0.0). Mesh and SFU
realize the extension space Principle IX preserves; modes live in
their own feature-scoped subtrees and never edit each other. SFU's
in-process Pion-based `mediafabric/` is the only Principle III scoped
divergence and is isolated to the SFU mode subtree.
<!-- SPECKIT END -->
