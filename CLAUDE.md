<!-- SPECKIT START -->
This repo is a multi-mode WebRTC playground. Each WebRTC topology is a
self-contained **mode**; the app shell only chooses one. Read
`specs/architecture.md` first — it documents the per-mode layout,
boundary rules, and "adding a new mode" checklist.

Active feature: **Multi-party Mesh WebRTC Learning Room** on branch
`002-webrtc-mesh-room`. Mesh is **additive** alongside the preserved
001 1:1 codepath; the 001 spec, contract, and behavior remain frozen.

Layout:

- Frontend modes: `frontend/src/modes/{one-to-one,mesh}/`.
- Frontend shared: `frontend/src/shared/` (cross-mode primitives only).
- Frontend app shell: `frontend/src/app/{App,routes,ModeBadge,modes}.tsx`.
- Backend modes: `signaling/internal/modes/{onetoone,mesh}/`.
- Backend shared: `signaling/internal/shared/{logging,heartbeat,config}/`.
- Backend tests: `signaling/tests/modes/{onetoone,mesh}/`.
- Boundary audit: `scripts/audit-boundaries.sh` (run as part of validation).

Per-version specs (immutable historical records):

- Architecture rules: `specs/architecture.md`
- 002 mesh: `specs/002-webrtc-mesh-room/{spec,plan,data-model,quickstart,checklists/}.md` + `contracts/signaling-protocol.md`
- 001 1:1 (frozen, do NOT edit): `specs/001-webrtc-1to1-call/{plan,quickstart}.md` + `contracts/signaling-protocol.md`

Constitution: `.specify/memory/constitution.md` (v2.0.0). Mesh and any
future mode realize the extension space Principle IX preserves; modes
live in their own feature-scoped subtrees and never edit each other.
<!-- SPECKIT END -->
