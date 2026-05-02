// PairManager (Phase F5 — full verb split).
//
// Owns Map<pairId, MeshPairContext> + lifecycle (createMeshPairManager,
// helpers transitionState/patchPairView/logStaleDrop, the snapshot/list
// accessors, closeAll, closePairByRemotePeerId). Negotiation, trickle,
// failure, and reconnect verbs live in their own files
// (`pair_negotiation.ts`, `pair_trickle.ts`, `reconnect.ts`) and run
// over the shared `MeshCtx` constructed here.
//
// Stale-epoch guard (T050): every inbound pair_offer / pair_answer
// must carry the SAME pairEpoch as the local PairContext. Stale
// payloads are dropped via `logStaleDrop`; setRemoteDescription is
// NOT called and PairContext state is NOT mutated.
//
// Existing-pair stability (T051 / FR-022a / L18): when newcomer
// instructions arrive, only the new pairs are allocated; existing
// PairContext entries (pc, dc, senders, state, pairEpoch) are left
// strictly untouched.

import type { MeshPairContext, MeshPairState } from "./pairContext";
import { makeMeshLog } from "./log";
import type { MeshCtx, MeshDeps, PairViewPatch } from "./ctx";
import {
  allocateContext,
  emitOffer,
  handleNewcomerInstructions,
  handlePairAnswer,
  handlePairOffer,
  type PairAnswerInput,
  type PairNegotiationInstructionInput,
  type PairOfferInput,
} from "./pair_negotiation";
import {
  handlePairIceCandidate,
  type PairIceCandidateInput,
} from "./pair_trickle";
import {
  clearReconnectRequested,
  handlePairFailed,
  handlePairReconnectInstruction,
  reconnectPair,
  type PairFailedInput,
  type PairReconnectInstructionInput,
} from "./reconnect";

export type {
  MeshDeps as MeshPairManagerDeps,
  MeshLocalMediaSource,
  MeshPeerConnectionFactory,
  MeshSignalingSendFn,
} from "./ctx";

export type {
  PairNegotiationInstructionInput,
  PairOfferInput,
  PairAnswerInput,
} from "./pair_negotiation";
export type { PairIceCandidateInput } from "./pair_trickle";
export type {
  PairFailedInput,
  PairFailedReason,
  PairReconnectInstructionInput,
} from "./reconnect";

// Re-export emitOffer for the existing test that asserts on it via
// the manager's outbound flow; the verb files don't need to re-export.
export { emitOffer };

export interface MeshChatSendablePairView {
  readonly pairId: string;
  readonly remotePeerId: string;
  readonly dc: RTCDataChannel | null;
}

export interface MeshPairManager {
  readonly handleNegotiationInstruction: (
    input: PairNegotiationInstructionInput,
  ) => Promise<MeshPairContext | null>;
  readonly handleNewcomerInstructions: (
    inputs: ReadonlyArray<PairNegotiationInstructionInput>,
  ) => Promise<MeshPairContext[]>;
  readonly handlePairOffer: (input: PairOfferInput) => Promise<void>;
  readonly handlePairAnswer: (input: PairAnswerInput) => Promise<void>;
  readonly handlePairIceCandidate: (
    input: PairIceCandidateInput,
  ) => Promise<void>;
  readonly handlePairFailed: (input: PairFailedInput) => void;
  readonly handlePairReconnectInstruction: (
    input: PairReconnectInstructionInput,
  ) => Promise<MeshPairContext | null>;
  readonly reconnectPair: (pairId: string) => void;
  readonly clearReconnectRequested: (pairId: string) => void;
  readonly getContext: (pairId: string) => MeshPairContext | undefined;
  readonly listContexts: () => MeshPairContext[];
  readonly listChatPairs: () => MeshChatSendablePairView[];
  readonly snapshotContext: (
    pairId: string,
  ) => Readonly<MeshPairContext> | null;
  readonly closeAll: () => void;
  readonly closePairByRemotePeerId: (remotePeerId: string) => boolean;
}

export function createMeshPairManager(deps: MeshDeps): MeshPairManager {
  const pairs = new Map<string, MeshPairContext>();

  const log = makeMeshLog((entry) =>
    deps.dispatch({ type: "MESH_EVENT_APPEND", entry }),
  );

  function patchPairView(
    pair: MeshPairContext,
    patch: PairViewPatch,
  ): void {
    deps.dispatch({
      type: "MESH_PAIR_VIEW_PATCHED",
      pairId: pair.pairId,
      patch,
    });
  }

  function transitionState(
    pair: MeshPairContext,
    next: MeshPairState,
    summary: string,
  ): void {
    const previous = pair.state;
    pair.state = next;
    log.pair({
      type: "future_phase_message",
      summary: `pair ${pair.pairId} ${summary} (${previous} → ${next})`,
      peerId: pair.remotePeerId,
      pairId: pair.pairId,
      detail: {
        pairEpoch: pair.pairEpoch,
        role: pair.role,
        previousState: previous,
        nextState: next,
      },
    });
  }

  function logStaleDrop(
    pairId: string,
    receivedEpoch: number,
    currentEpoch: number,
    remotePeerId: string,
    inboundType: "pair_offer" | "pair_answer",
  ): void {
    log.pair({
      type: "future_phase_message",
      summary: `pair_stale_message_dropped: ${inboundType} for pair ${pairId} (received epoch=${receivedEpoch}, current=${currentEpoch})`,
      peerId: remotePeerId,
      pairId,
      detail: {
        kind: "pair_stale_message_dropped",
        inboundType,
        receivedEpoch,
        currentEpoch,
      },
    });
  }

  const ctx: MeshCtx = {
    deps,
    log,
    pairs,
    patchPairView,
    transitionState,
    logStaleDrop,
  };

  function getContext(pairId: string): MeshPairContext | undefined {
    return pairs.get(pairId);
  }

  function listContexts(): MeshPairContext[] {
    return Array.from(pairs.values());
  }

  function listChatPairs(): MeshChatSendablePairView[] {
    return Array.from(pairs.values())
      .sort((a, b) => a.remoteAdmissionIndex - b.remoteAdmissionIndex)
      .map((pair) => ({
        pairId: pair.pairId,
        remotePeerId: pair.remotePeerId,
        dc: pair.dc,
      }));
  }

  function snapshotContext(
    pairId: string,
  ): Readonly<MeshPairContext> | null {
    const pair = pairs.get(pairId);
    if (!pair) return null;
    return Object.freeze({
      pairId: pair.pairId,
      pairEpoch: pair.pairEpoch,
      role: pair.role,
      remotePeerId: pair.remotePeerId,
      remoteAdmissionIndex: pair.remoteAdmissionIndex,
      pc: pair.pc,
      dc: pair.dc,
      senders: pair.senders,
      state: pair.state,
      iceBuffer: pair.iceBuffer,
      remoteDescriptionApplied: pair.remoteDescriptionApplied,
      endOfLocalCandidatesSent: pair.endOfLocalCandidatesSent,
      endOfRemoteCandidatesReceived: pair.endOfRemoteCandidatesReceived,
      failedReported: pair.failedReported,
      reconnectRequested: pair.reconnectRequested,
    });
  }

  function closeAll(): void {
    for (const pair of pairs.values()) {
      try {
        pair.dc?.close();
      } catch {
        // ignore — already closed / never opened
      }
      try {
        pair.pc.close();
      } catch {
        // ignore — already closed
      }
      pair.iceBuffer.clear();
      pair.state = "closed";
      deps.dispatch({ type: "MESH_PAIR_REMOVED", pairId: pair.pairId });
    }
    pairs.clear();
  }

  function closePairByRemotePeerId(remotePeerId: string): boolean {
    let target: MeshPairContext | undefined;
    for (const pair of pairs.values()) {
      if (pair.remotePeerId === remotePeerId) {
        target = pair;
        break;
      }
    }
    if (!target) return false;
    try {
      target.dc?.close();
    } catch {
      // ignore — already closed / never opened
    }
    try {
      target.pc.close();
    } catch {
      // ignore — already closed
    }
    target.iceBuffer.clear();
    target.state = "closed";
    pairs.delete(target.pairId);
    deps.dispatch({ type: "MESH_PAIR_REMOVED", pairId: target.pairId });
    return true;
  }

  return {
    handleNegotiationInstruction: (input) =>
      allocateContext(ctx, input, "fresh"),
    handleNewcomerInstructions: (inputs) =>
      handleNewcomerInstructions(ctx, inputs),
    handlePairOffer: (input) => handlePairOffer(ctx, input),
    handlePairAnswer: (input) => handlePairAnswer(ctx, input),
    handlePairIceCandidate: (input) => handlePairIceCandidate(ctx, input),
    handlePairFailed: (input) => handlePairFailed(ctx, input),
    handlePairReconnectInstruction: (input) =>
      handlePairReconnectInstruction(ctx, input),
    reconnectPair: (pairId) => reconnectPair(ctx, pairId),
    clearReconnectRequested: (pairId) =>
      clearReconnectRequested(ctx, pairId),
    getContext,
    listContexts,
    listChatPairs,
    snapshotContext,
    closeAll,
    closePairByRemotePeerId,
  };
}
