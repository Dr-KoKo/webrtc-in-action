<!-- SPECKIT START -->
Active feature: **Multi-party Mesh WebRTC Learning Room** on branch
`002-webrtc-mesh-room`. Mesh is **additive** alongside the preserved
001 1:1 codepath; the 001 spec, contract, and behavior remain frozen
(see plan §6 "001 Preservation Boundary").

For the mesh technology stack, module layout, v2 signaling contract,
phased implementation plan, and test strategy, read the plan and its
Phase 1 artifacts:

- Plan: `specs/002-webrtc-mesh-room/plan.md`
- Feature spec: `specs/002-webrtc-mesh-room/spec.md`
- Phase 0 research: `specs/002-webrtc-mesh-room/research.md`
- Phase 1 data model: `specs/002-webrtc-mesh-room/data-model.md`
- Phase 1 v2 mesh signaling contract (single source of truth for mesh
  messages on `/ws/mesh`):
  `specs/002-webrtc-mesh-room/contracts/signaling-protocol.md`
- Phase 1 mesh quickstart + manual verification checklist:
  `specs/002-webrtc-mesh-room/quickstart.md`
- Mesh spec-quality checklist (53 / 53 PASS, pass 2):
  `specs/002-webrtc-mesh-room/checklists/mesh.md`

The 001 plan and Phase 1 artifacts remain authoritative for 1:1 mode
and MUST NOT be edited:

- 001 plan: `specs/001-webrtc-1to1-call/plan.md`
- 001 v1 signaling contract (canonical for `/ws`):
  `specs/001-webrtc-1to1-call/contracts/signaling-protocol.md`
- 001 quickstart (regression checklist for mesh M12 DoD):
  `specs/001-webrtc-1to1-call/quickstart.md`

Constitution: `.specify/memory/constitution.md` (v2.0.0). Mesh is the
extension Principle IX explicitly preserved space for; mesh code lives
in feature-scoped modules (`frontend/src/features/mesh/`,
`signaling/internal/mesh/`) and never edits 001 modules in
behavior-changing ways.
<!-- SPECKIT END -->
