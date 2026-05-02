// Failure + reconnect verbs for mesh (Phase F5).
//
//   emitOutboundPairFailed       — outbound `pair_failed` (we detected
//                                  the failure locally; tell the peer).
//   handlePairFailed             — inbound `pair_failed` (the peer
//                                  detected the failure; mark ONLY the
//                                  matching PairContext failed).
//   reconnectPair                — user-initiated `reconnect_pair`
//                                  (sets `reconnectRequested` + sends).
//   clearReconnectRequested      — clear the in-flight flag after a
//                                  server error reply (e.g. stale_pair_epoch).
//   handlePairReconnectInstruction — server-driven rebuild of one pair
//                                  under a new epoch.
//
// Free functions over MeshCtx; no React, no provider state.

import { MESH_CONTRACT_VERSION } from "../protocol/schema";
import type { MeshPairContext } from "./pairContext";
import type { MeshCtx } from "./ctx";
import {
  allocateContext,
  type PairNegotiationInstructionInput,
} from "./pair_negotiation";

// PairFailedReason — mirror of the v2 contract enum (§3.16). Kept as a
// string union so the manager can emit / receive without depending on
// the Zod schema at runtime.
export type PairFailedReason =
  | "ice_failure"
  | "dtls_failure"
  | "transport_drop"
  | "connection_state_failed"
  | "application";

export interface PairFailedInput {
  readonly pairId: string;
  readonly pairEpoch: number;
  readonly reason: PairFailedReason;
  readonly detail?: string;
}

// PairReconnectInstructionInput — same shape as the negotiation
// instruction (contract §3.15 reuses §3.9's payload). Distinct type so
// the manager's reconnect path is a separate code branch from initial
// allocation.
export interface PairReconnectInstructionInput
  extends PairNegotiationInstructionInput {}

// emitOutboundPairFailed — emit one outbound `pair_failed` envelope to
// the other endpoint. Idempotent at the per-attempt level via
// `pair.failedReported`; the caller checks-and-sets that flag.
export function emitOutboundPairFailed(
  ctx: MeshCtx,
  pair: MeshPairContext,
  reason: PairFailedReason,
  detail: string,
): void {
  const { deps, log } = ctx;
  try {
    deps.send({
      v: MESH_CONTRACT_VERSION,
      type: "pair_failed",
      roomId: deps.roomId,
      to: pair.remotePeerId,
      payload: {
        pairId: pair.pairId,
        pairEpoch: pair.pairEpoch,
        reason,
        detail,
      },
    });
  } catch (err) {
    log.local({
      type: "signaling_error",
      summary: `failed to send pair_failed for pair ${pair.pairId}: ${
        (err as Error).message ?? "unknown"
      }`,
    });
  }
  log.pair({
    type: "future_phase_message",
    summary: `peer pair failed (pair ${pair.pairId}, reason=${reason})`,
    peerId: pair.remotePeerId,
    pairId: pair.pairId,
    detail: {
      kind: "peer_pair_failed",
      direction: "local",
      pairId: pair.pairId,
      remotePeerId: pair.remotePeerId,
      reason,
      detailText: detail,
      connectionState: "failed",
      pairEpoch: pair.pairEpoch,
    },
  });
}

// handlePairFailed — inbound `pair_failed` from the remote endpoint
// (server relays C→S→C). Marks ONLY the matching PairContext failed;
// never touches other PairContexts, the local roster, or media tracks.
// Stale pairEpoch is dropped + logged.
export function handlePairFailed(
  ctx: MeshCtx,
  input: PairFailedInput,
): void {
  const { log, pairs } = ctx;
  const pair = pairs.get(input.pairId);
  if (!pair) {
    log.room({
      type: "error_occurred",
      summary: `pair_failed received for unknown pair ${input.pairId} — ignored`,
      detail: {
        kind: "pair_failed_unknown_pair",
        pairId: input.pairId,
        pairEpoch: input.pairEpoch,
        reason: input.reason,
      },
    });
    return;
  }
  if (input.pairEpoch !== pair.pairEpoch) {
    log.pair({
      type: "future_phase_message",
      summary: `pair_stale_message_dropped: pair_failed for pair ${pair.pairId} (received epoch=${input.pairEpoch}, current=${pair.pairEpoch})`,
      peerId: pair.remotePeerId,
      pairId: pair.pairId,
      detail: {
        kind: "pair_stale_message_dropped",
        direction: "remote",
        inboundType: "pair_failed",
        receivedEpoch: input.pairEpoch,
        currentEpoch: pair.pairEpoch,
      },
    });
    return;
  }
  pair.state = "failed";
  pair.failedReported = true;
  ctx.patchPairView(pair, { connectionState: "failed" });
  log.pair({
    type: "future_phase_message",
    summary: `peer pair failed (received from remote, pair ${pair.pairId}, reason=${input.reason})`,
    peerId: pair.remotePeerId,
    pairId: pair.pairId,
    detail: {
      kind: "peer_pair_failed",
      direction: "remote",
      pairId: pair.pairId,
      remotePeerId: pair.remotePeerId,
      reason: input.reason,
      detailText: input.detail,
      connectionState: "failed",
      pairEpoch: pair.pairEpoch,
    },
  });
}

// reconnectPair — user clicked Reconnect on a failed remote tile.
// Sends exactly one `reconnect_pair { pairId, observedEpoch }` to the
// server; flips `reconnectRequested` so the button disables itself
// until the server replies. Idempotent — a second click while in
// flight is a no-op.
export function reconnectPair(ctx: MeshCtx, pairId: string): void {
  const { deps, log, pairs } = ctx;
  const pair = pairs.get(pairId);
  if (!pair) {
    log.room({
      type: "error_occurred",
      summary: `reconnectPair called for unknown pair ${pairId} — ignored`,
      detail: { kind: "reconnect_pair_unknown_pair", pairId },
    });
    return;
  }
  if (pair.state !== "failed") {
    log.pair({
      type: "future_phase_message",
      summary: `reconnectPair ignored: pair ${pairId} not in failed state (state=${pair.state})`,
      peerId: pair.remotePeerId,
      pairId,
      detail: {
        kind: "reconnect_pair_not_failed",
        state: pair.state,
        pairEpoch: pair.pairEpoch,
      },
    });
    return;
  }
  if (pair.reconnectRequested) {
    log.pair({
      type: "future_phase_message",
      summary: `reconnectPair ignored: already in flight for pair ${pairId}`,
      peerId: pair.remotePeerId,
      pairId,
      detail: {
        kind: "reconnect_pair_in_flight",
        pairEpoch: pair.pairEpoch,
      },
    });
    return;
  }
  pair.reconnectRequested = true;
  ctx.patchPairView(pair, { reconnectRequested: true });
  try {
    deps.send({
      v: MESH_CONTRACT_VERSION,
      type: "reconnect_pair",
      roomId: deps.roomId,
      payload: {
        pairId: pair.pairId,
        observedEpoch: pair.pairEpoch,
      },
    });
  } catch (err) {
    // Roll the flag back on send failure so the user can retry.
    pair.reconnectRequested = false;
    ctx.patchPairView(pair, { reconnectRequested: false });
    log.local({
      type: "signaling_error",
      summary: `failed to send reconnect_pair for pair ${pairId}: ${
        (err as Error).message ?? "unknown"
      }`,
    });
    return;
  }
  log.pair({
    type: "future_phase_message",
    summary: `peer pair reconnect requested (pair ${pairId}, observedEpoch=${pair.pairEpoch})`,
    peerId: pair.remotePeerId,
    pairId,
    detail: {
      kind: "peer_pair_reconnect_requested",
      observedEpoch: pair.pairEpoch,
    },
  });
}

export function clearReconnectRequested(ctx: MeshCtx, pairId: string): void {
  const pair = ctx.pairs.get(pairId);
  if (!pair) return;
  if (!pair.reconnectRequested) return;
  pair.reconnectRequested = false;
  ctx.patchPairView(pair, { reconnectRequested: false });
}

// handlePairReconnectInstruction — server replied with
// pair_reconnect_instruction. Tear down ONLY the affected pair
// (close DC, close PC, drop refs, clear iceBuffer) and rebuild a
// fresh PairContext under the new pairEpoch. Local MediaStreamTracks
// keep running; other PairContexts are strictly untouched.
export async function handlePairReconnectInstruction(
  ctx: MeshCtx,
  input: PairReconnectInstructionInput,
): Promise<MeshPairContext | null> {
  const { deps, log, pairs } = ctx;
  const existing = pairs.get(input.pairId);
  if (!existing) {
    log.pair({
      type: "future_phase_message",
      summary: `pair_reconnect_instruction for unknown pair ${input.pairId} — allocating fresh PairContext`,
      peerId: input.remotePeerId,
      pairId: input.pairId,
      detail: {
        kind: "pair_reconnect_instruction_no_prior",
        newEpoch: input.pairEpoch,
      },
    });
    return allocateContext(ctx, input, "reconnect");
  }
  if (input.pairEpoch <= existing.pairEpoch) {
    log.pair({
      type: "future_phase_message",
      summary: `pair_stale_message_dropped: pair_reconnect_instruction for pair ${input.pairId} (received epoch=${input.pairEpoch}, current=${existing.pairEpoch})`,
      peerId: existing.remotePeerId,
      pairId: existing.pairId,
      detail: {
        kind: "pair_stale_message_dropped",
        direction: "remote",
        inboundType: "pair_reconnect_instruction",
        receivedEpoch: input.pairEpoch,
        currentEpoch: existing.pairEpoch,
      },
    });
    return null;
  }
  log.pair({
    type: "future_phase_message",
    summary: `peer pair fresh attempt started (pair ${input.pairId}, new epoch ${input.pairEpoch})`,
    peerId: existing.remotePeerId,
    pairId: existing.pairId,
    detail: {
      kind: "peer_pair_fresh_attempt_started",
      previousEpoch: existing.pairEpoch,
      newEpoch: input.pairEpoch,
      role: input.role,
    },
  });
  // Tear down old DC, PC, refs, iceBuffer. Local MediaStreamTracks
  // are NOT stopped (the rebuild re-attaches them).
  try {
    existing.dc?.close();
  } catch {
    // already closed / never opened — fine.
  }
  try {
    existing.pc.close();
  } catch {
    // already closed — fine.
  }
  existing.iceBuffer.clear();
  existing.state = "closed";
  pairs.delete(existing.pairId);
  log.pair({
    type: "future_phase_message",
    summary: `old PairContext torn down (pair ${input.pairId}, previous epoch=${existing.pairEpoch})`,
    peerId: existing.remotePeerId,
    pairId: existing.pairId,
    detail: {
      kind: "pair_old_context_torn_down",
      previousEpoch: existing.pairEpoch,
    },
  });
  // Drop the React view entry so the reducer accepts the fresh
  // MESH_PAIR_REGISTERED dispatched inside allocateContext.
  deps.dispatch({ type: "MESH_PAIR_REMOVED", pairId: input.pairId });
  const fresh = await allocateContext(ctx, input, "reconnect");
  if (fresh) {
    log.pair({
      type: "future_phase_message",
      summary: `new PairContext created (pair ${input.pairId}, epoch ${fresh.pairEpoch}, role=${fresh.role})`,
      peerId: fresh.remotePeerId,
      pairId: fresh.pairId,
      detail: {
        kind: "pair_new_context_created",
        pairEpoch: fresh.pairEpoch,
        role: fresh.role,
        previousEpoch: existing.pairEpoch,
      },
    });
  }
  return fresh;
}
