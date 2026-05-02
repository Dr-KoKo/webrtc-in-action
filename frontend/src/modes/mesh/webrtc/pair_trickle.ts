// Trickle ICE verbs for mesh (Phase F5).
//
//   sendLocalCandidate   — outbound `pair_ice_candidate` (incl. EOC).
//   handlePairIceCandidate — inbound trickle; routed through the
//                            per-pair IceBuffer until SRD resolves.
//   flushIceBuffer       — drain buffered candidates after SRD.
//   applyRemoteCandidate — addIceCandidate + narration; tolerates
//                          end-of-candidates (W3C: no-arg form).
//
// Free functions over MeshCtx; no React, no provider state.

import { MESH_CONTRACT_VERSION } from "../protocol/schema";
import type { MeshPairContext } from "./pairContext";
import type { BufferedIceCandidate } from "./iceBuffer";
import type { MeshCtx, WireIceCandidate } from "./ctx";

export interface PairIceCandidateInput {
  readonly pairId: string;
  readonly pairEpoch: number;
  /** `null` = end-of-candidates (contract §3.12). */
  readonly candidate: RTCIceCandidateInit | null;
}

export function sendLocalCandidate(
  ctx: MeshCtx,
  pair: MeshPairContext,
  candidate: WireIceCandidate | null,
): void {
  const { deps, log } = ctx;
  if (candidate === null) {
    if (pair.endOfLocalCandidatesSent) return;
    pair.endOfLocalCandidatesSent = true;
  }
  deps.send({
    v: MESH_CONTRACT_VERSION,
    type: "pair_ice_candidate",
    roomId: deps.roomId,
    to: pair.remotePeerId,
    payload: {
      pairId: pair.pairId,
      pairEpoch: pair.pairEpoch,
      candidate,
    },
  });
  if (candidate === null) {
    log.pair({
      type: "future_phase_message",
      summary: `ICE end-of-candidates sent (pair ${pair.pairId})`,
      peerId: pair.remotePeerId,
      pairId: pair.pairId,
      detail: {
        kind: "ice_eoc_sent",
        direction: "local",
        pairEpoch: pair.pairEpoch,
      },
    });
  } else {
    log.pair({
      type: "future_phase_message",
      summary: `ICE candidate sent (pair ${pair.pairId})`,
      peerId: pair.remotePeerId,
      pairId: pair.pairId,
      detail: {
        kind: "ice_candidate_sent",
        direction: "local",
        pairEpoch: pair.pairEpoch,
      },
    });
  }
}

export async function flushIceBuffer(
  ctx: MeshCtx,
  pair: MeshPairContext,
): Promise<void> {
  const { log } = ctx;
  if (pair.iceBuffer.size() === 0) return;
  const drained: number[] = [];
  await pair.iceBuffer.drain(async (cand) => {
    drained.push(0);
    await applyRemoteCandidate(ctx, pair, cand, "flushed");
  });
  log.pair({
    type: "future_phase_message",
    summary: `ICE buffer flushed (${drained.length} candidate${drained.length === 1 ? "" : "s"}, pair ${pair.pairId})`,
    peerId: pair.remotePeerId,
    pairId: pair.pairId,
    detail: {
      kind: "ice_buffer_flushed",
      direction: "system",
      count: drained.length,
      pairEpoch: pair.pairEpoch,
    },
  });
}

export async function applyRemoteCandidate(
  ctx: MeshCtx,
  pair: MeshPairContext,
  candidate: BufferedIceCandidate,
  source: "live" | "flushed",
): Promise<void> {
  const { log } = ctx;
  try {
    // Per W3C, calling addIceCandidate() with no argument signals
    // end-of-candidates. We pass `undefined` for null so we never
    // emit `candidate: ""`.
    if (candidate === null) {
      await pair.pc.addIceCandidate();
    } else {
      await pair.pc.addIceCandidate(candidate);
    }
  } catch (err) {
    log.pair({
      type: "error_occurred",
      summary: `addIceCandidate failed (pair ${pair.pairId}, source=${source})`,
      peerId: pair.remotePeerId,
      pairId: pair.pairId,
      detail: {
        kind: "ice_candidate_apply_failed",
        direction: "system",
        source,
        pairEpoch: pair.pairEpoch,
        error: err instanceof Error ? err.message : String(err),
      },
    });
    return;
  }
  if (candidate === null) {
    pair.endOfRemoteCandidatesReceived = true;
    log.pair({
      type: "future_phase_message",
      summary: `ICE end-of-candidates received (pair ${pair.pairId})`,
      peerId: pair.remotePeerId,
      pairId: pair.pairId,
      detail: {
        kind: "ice_eoc_received",
        direction: "remote",
        source,
        pairEpoch: pair.pairEpoch,
      },
    });
  } else {
    log.pair({
      type: "future_phase_message",
      summary: `ICE candidate received (pair ${pair.pairId})`,
      peerId: pair.remotePeerId,
      pairId: pair.pairId,
      detail: {
        kind: "ice_candidate_received",
        direction: "remote",
        source,
        pairEpoch: pair.pairEpoch,
      },
    });
  }
}

export async function handlePairIceCandidate(
  ctx: MeshCtx,
  input: PairIceCandidateInput,
): Promise<void> {
  const { log, pairs } = ctx;
  const pair = pairs.get(input.pairId);
  if (!pair) {
    log.room({
      type: "error_occurred",
      summary: `pair_ice_candidate received for unknown pair ${input.pairId} — ignored`,
      detail: {
        kind: "ice_candidate_unknown_pair",
        direction: "remote",
        pairId: input.pairId,
        pairEpoch: input.pairEpoch,
      },
    });
    return;
  }
  if (input.pairEpoch !== pair.pairEpoch) {
    log.pair({
      type: "future_phase_message",
      summary: `pair_stale_message_dropped: pair_ice_candidate for pair ${pair.pairId} (received epoch=${input.pairEpoch}, current=${pair.pairEpoch})`,
      peerId: pair.remotePeerId,
      pairId: pair.pairId,
      detail: {
        kind: "pair_stale_message_dropped",
        direction: "remote",
        inboundType: "pair_ice_candidate",
        receivedEpoch: input.pairEpoch,
        currentEpoch: pair.pairEpoch,
      },
    });
    return;
  }
  if (!pair.remoteDescriptionApplied) {
    pair.iceBuffer.push(input.candidate);
    log.pair({
      type: "future_phase_message",
      summary:
        input.candidate === null
          ? `ICE end-of-candidates buffered (pair ${pair.pairId})`
          : `ICE candidate buffered (pair ${pair.pairId})`,
      peerId: pair.remotePeerId,
      pairId: pair.pairId,
      detail: {
        kind: "ice_candidate_buffered",
        direction: "remote",
        endOfCandidates: input.candidate === null,
        pairEpoch: pair.pairEpoch,
      },
    });
    return;
  }
  await applyRemoteCandidate(ctx, pair, input.candidate, "live");
}
