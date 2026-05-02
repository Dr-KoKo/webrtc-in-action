// Phase F5 barrel — the implementation moved into per-verb files
// (`pair-manager.ts`, `pair_negotiation.ts`, `pair_trickle.ts`,
// `reconnect.ts`) per specs/frontend-architecture.md §3.2. This file
// stays as a re-export so the 16 existing importers (production +
// tests) keep working without touching their import paths.

export {
  createMeshPairManager,
  type MeshPairManager,
  type MeshPairManagerDeps,
  type MeshLocalMediaSource,
  type MeshPeerConnectionFactory,
  type MeshSignalingSendFn,
  type MeshChatSendablePairView,
  type PairNegotiationInstructionInput,
  type PairOfferInput,
  type PairAnswerInput,
  type PairIceCandidateInput,
  type PairFailedInput,
  type PairFailedReason,
  type PairReconnectInstructionInput,
  emitOffer,
} from "./pair-manager";
