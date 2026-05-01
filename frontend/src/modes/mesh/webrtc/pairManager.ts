// PairManager (T046 + T048 + T050 + T051) — owns Map<pairId, PairContext>.
// Handles pair_negotiation_instruction → allocate one RTCPeerConnection,
// attach the SAME local audio + video MediaStreamTracks across every
// pair (data-model §B.3, sender count invariant 2 × N−1), and run the
// offerer/answerer SDP exchange.
//
// M6 hard boundary:
//   - No ICE wiring (M7 owns onicecandidate + addIceCandidate).
//   - No remote tile rendering (M7).
//   - No chat sending / receiving / UI (M8).
//   - No pair_media_state runtime, no toggles, no screen-share, no reconnect.
//
// Stale-epoch guard (T050): every inbound pair_offer / pair_answer
// must carry the SAME pairEpoch as the local PairContext. Stale
// payloads are dropped with a `pair_stale_message_dropped` event-log
// entry; setRemoteDescription is NOT called and PairContext state is
// NOT mutated.
//
// Existing-pair stability (T051 / FR-022a / L18): when newcomer
// instructions arrive, only the new pairs are allocated; existing
// PairContext entries (pc, dc, senders, state, pairEpoch) are left
// strictly untouched.

import type { Dispatch } from "react";
import type { MeshRootAction } from "../state";
import { makeMeshEventEntry } from "../state/eventLog";
import {
  MESH_CONTRACT_VERSION,
  type MeshClientMessage,
} from "../signaling/schema";
import {
  attachAnswererDataChannelHandler,
  createOffererDataChannel,
} from "./dataChannel";
import type {
  MeshPairContext,
  MeshPairRole,
  MeshPairState,
} from "./pairContext";

// PeerConnectionFactory — pluggable for tests. Production passes
// `(cfg) => new RTCPeerConnection(cfg)`.
export type MeshPeerConnectionFactory = (
  cfg: RTCConfiguration,
) => RTCPeerConnection;

export interface MeshLocalMediaSource {
  // Returns the live audio/video tracks that every PairContext re-uses.
  // Order is irrelevant; the manager attaches each one.
  getTracks(): MediaStreamTrack[];
  // Convenience for `addTrack(track, stream)` — the second argument
  // is what the remote side will see as the MediaStream id. Most
  // tests don't care; the production path threads the real local
  // MediaStream so remote `pc.ontrack` event.streams[0] is stable.
  getStream(): MediaStream | null;
}

export interface MeshSignalingSendFn {
  (message: MeshClientMessage): void;
}

export interface MeshPairManagerDeps {
  readonly roomId: string;
  readonly localPeerId: string;
  readonly dispatch: Dispatch<MeshRootAction>;
  readonly send: MeshSignalingSendFn;
  readonly mediaSource: MeshLocalMediaSource;
  readonly peerConnectionFactory: MeshPeerConnectionFactory;
}

export interface PairNegotiationInstructionInput {
  readonly pairId: string;
  readonly pairEpoch: number;
  readonly role: MeshPairRole;
  readonly remotePeerId: string;
  readonly remoteAdmissionIndex: number;
  readonly iceServers: RTCIceServer[];
}

export interface PairOfferInput {
  readonly pairId: string;
  readonly pairEpoch: number;
  readonly sdp: RTCSessionDescriptionInit;
}

export interface PairAnswerInput {
  readonly pairId: string;
  readonly pairEpoch: number;
  readonly sdp: RTCSessionDescriptionInit;
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
  readonly getContext: (pairId: string) => MeshPairContext | undefined;
  readonly listContexts: () => MeshPairContext[];
  readonly snapshotContext: (pairId: string) => Readonly<MeshPairContext> | null;
  readonly closeAll: () => void;
}

export function createMeshPairManager(
  deps: MeshPairManagerDeps,
): MeshPairManager {
  const pairs = new Map<string, MeshPairContext>();

  function appendEvent(entry: Parameters<typeof makeMeshEventEntry>[0]): void {
    deps.dispatch({
      type: "MESH_EVENT_APPEND",
      entry: makeMeshEventEntry(entry),
    });
  }

  function transitionState(
    ctx: MeshPairContext,
    next: MeshPairState,
    summary: string,
  ): void {
    const previous = ctx.state;
    ctx.state = next;
    appendEvent({
      scope: "pair",
      type: "future_phase_message",
      summary: `pair ${ctx.pairId} ${summary} (${previous} → ${next})`,
      peerId: ctx.remotePeerId,
      pairId: ctx.pairId,
      detail: {
        pairEpoch: ctx.pairEpoch,
        role: ctx.role,
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
    appendEvent({
      scope: "pair",
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

  // allocateContext — idempotent per (pairId + pairEpoch). A duplicate
  // instruction with the same epoch returns the existing context
  // without creating a second pc / dc / sender set.
  async function allocateContext(
    input: PairNegotiationInstructionInput,
  ): Promise<MeshPairContext | null> {
    const existing = pairs.get(input.pairId);
    if (existing) {
      if (existing.pairEpoch === input.pairEpoch) {
        appendEvent({
          scope: "pair",
          type: "future_phase_message",
          summary: `duplicate pair_negotiation_instruction ignored (pair ${input.pairId}, epoch ${input.pairEpoch})`,
          peerId: existing.remotePeerId,
          pairId: existing.pairId,
          detail: {
            kind: "duplicate_instruction_noop",
            pairEpoch: input.pairEpoch,
            role: existing.role,
          },
        });
        return existing;
      }
      // A higher epoch is a reconnect (M11 territory). M6 explicitly
      // does not implement reconnect; log and bail without mutating
      // existing state so we don't accidentally tear down a live pair.
      appendEvent({
        scope: "pair",
        type: "future_phase_message",
        summary: `pair_negotiation_instruction with higher epoch arrived (M11 reconnect not yet wired) — ignored`,
        peerId: existing.remotePeerId,
        pairId: existing.pairId,
        detail: {
          kind: "instruction_higher_epoch_unhandled",
          currentEpoch: existing.pairEpoch,
          receivedEpoch: input.pairEpoch,
        },
      });
      return null;
    }

    const pc = deps.peerConnectionFactory({ iceServers: input.iceServers });
    const stream = deps.mediaSource.getStream();
    const tracks = deps.mediaSource.getTracks();
    const senders: RTCRtpSender[] = [];
    for (const track of tracks) {
      const sender = stream
        ? pc.addTrack(track, stream)
        : pc.addTrack(track);
      senders.push(sender);
    }

    const ctx: MeshPairContext = {
      pairId: input.pairId,
      pairEpoch: input.pairEpoch,
      role: input.role,
      remotePeerId: input.remotePeerId,
      remoteAdmissionIndex: input.remoteAdmissionIndex,
      pc,
      dc: null,
      senders,
      state: "new",
    };
    pairs.set(ctx.pairId, ctx);

    pc.onsignalingstatechange = () => {
      appendEvent({
        scope: "pair",
        type: "future_phase_message",
        summary: `signalingState changed → ${pc.signalingState} (pair ${ctx.pairId})`,
        peerId: ctx.remotePeerId,
        pairId: ctx.pairId,
        detail: {
          kind: "signaling_state_change",
          signalingState: pc.signalingState,
          pairEpoch: ctx.pairEpoch,
        },
      });
      if (pc.signalingState === "stable" && ctx.state !== "stable") {
        ctx.state = "stable";
      }
    };

    if (ctx.role === "offerer") {
      // FR-050 — DataChannel MUST be created before the offer so the
      // SDP carries the data m-line.
      createOffererDataChannel(ctx);
      await emitOffer(ctx);
    } else {
      attachAnswererDataChannelHandler(ctx, (dc) => {
        appendEvent({
          scope: "pair",
          type: "future_phase_message",
          summary: `data channel attached on answerer (pair ${ctx.pairId}, label=${dc.label}, readyState=${dc.readyState})`,
          peerId: ctx.remotePeerId,
          pairId: ctx.pairId,
          detail: {
            kind: "datachannel_attached",
            label: dc.label,
            readyState: dc.readyState,
          },
        });
      });
    }

    return ctx;
  }

  async function emitOffer(ctx: MeshPairContext): Promise<void> {
    transitionState(ctx, "creating-offer", "creating offer");
    const offer = await ctx.pc.createOffer();
    await ctx.pc.setLocalDescription(offer);
    transitionState(ctx, "have-local-offer", "offer created");
    deps.send({
      v: MESH_CONTRACT_VERSION,
      type: "pair_offer",
      roomId: deps.roomId,
      to: ctx.remotePeerId,
      payload: {
        pairId: ctx.pairId,
        pairEpoch: ctx.pairEpoch,
        sdp: { type: "offer", sdp: offer.sdp ?? "" },
      },
    });
    appendEvent({
      scope: "pair",
      type: "future_phase_message",
      summary: `offer sent (pair ${ctx.pairId})`,
      peerId: ctx.remotePeerId,
      pairId: ctx.pairId,
      detail: { kind: "offer_sent", pairEpoch: ctx.pairEpoch },
    });
  }

  async function handlePairOffer(input: PairOfferInput): Promise<void> {
    const ctx = pairs.get(input.pairId);
    if (!ctx) {
      // Out-of-order offer (instruction not yet processed). Defensive
      // log only — do NOT spawn a context here because the role
      // discrimination is server-authoritative.
      appendEvent({
        scope: "room",
        type: "error_occurred",
        summary: `pair_offer received for unknown pair ${input.pairId} — ignored`,
        detail: { pairId: input.pairId, pairEpoch: input.pairEpoch },
      });
      return;
    }
    if (ctx.role !== "answerer") {
      appendEvent({
        scope: "pair",
        type: "future_phase_message",
        summary: `pair_offer received but local role=${ctx.role} (pair ${ctx.pairId}) — ignored`,
        peerId: ctx.remotePeerId,
        pairId: ctx.pairId,
        detail: { kind: "wrong_role_offer_ignored" },
      });
      return;
    }
    if (input.pairEpoch !== ctx.pairEpoch) {
      logStaleDrop(
        ctx.pairId,
        input.pairEpoch,
        ctx.pairEpoch,
        ctx.remotePeerId,
        "pair_offer",
      );
      return;
    }
    appendEvent({
      scope: "pair",
      type: "future_phase_message",
      summary: `offer received (pair ${ctx.pairId})`,
      peerId: ctx.remotePeerId,
      pairId: ctx.pairId,
      detail: { kind: "offer_received", pairEpoch: ctx.pairEpoch },
    });
    transitionState(ctx, "have-remote-offer", "offer received");
    await ctx.pc.setRemoteDescription(input.sdp);
    transitionState(ctx, "creating-answer", "creating answer");
    const answer = await ctx.pc.createAnswer();
    await ctx.pc.setLocalDescription(answer);
    transitionState(ctx, "have-local-answer", "answer created");
    deps.send({
      v: MESH_CONTRACT_VERSION,
      type: "pair_answer",
      roomId: deps.roomId,
      to: ctx.remotePeerId,
      payload: {
        pairId: ctx.pairId,
        pairEpoch: ctx.pairEpoch,
        sdp: { type: "answer", sdp: answer.sdp ?? "" },
      },
    });
    appendEvent({
      scope: "pair",
      type: "future_phase_message",
      summary: `answer sent (pair ${ctx.pairId})`,
      peerId: ctx.remotePeerId,
      pairId: ctx.pairId,
      detail: { kind: "answer_sent", pairEpoch: ctx.pairEpoch },
    });
  }

  async function handlePairAnswer(input: PairAnswerInput): Promise<void> {
    const ctx = pairs.get(input.pairId);
    if (!ctx) {
      appendEvent({
        scope: "room",
        type: "error_occurred",
        summary: `pair_answer received for unknown pair ${input.pairId} — ignored`,
        detail: { pairId: input.pairId, pairEpoch: input.pairEpoch },
      });
      return;
    }
    if (ctx.role !== "offerer") {
      appendEvent({
        scope: "pair",
        type: "future_phase_message",
        summary: `pair_answer received but local role=${ctx.role} (pair ${ctx.pairId}) — ignored`,
        peerId: ctx.remotePeerId,
        pairId: ctx.pairId,
        detail: { kind: "wrong_role_answer_ignored" },
      });
      return;
    }
    if (input.pairEpoch !== ctx.pairEpoch) {
      logStaleDrop(
        ctx.pairId,
        input.pairEpoch,
        ctx.pairEpoch,
        ctx.remotePeerId,
        "pair_answer",
      );
      return;
    }
    appendEvent({
      scope: "pair",
      type: "future_phase_message",
      summary: `answer received (pair ${ctx.pairId})`,
      peerId: ctx.remotePeerId,
      pairId: ctx.pairId,
      detail: { kind: "answer_received", pairEpoch: ctx.pairEpoch },
    });
    transitionState(ctx, "have-remote-answer", "answer received");
    await ctx.pc.setRemoteDescription(input.sdp);
    if (ctx.pc.signalingState === "stable") {
      ctx.state = "stable";
    }
  }

  // handleNewcomerInstructions — T051 / L18: when a newcomer's
  // instructions arrive in a batch, allocate only the new pairs.
  // Existing PairContext entries (pc, dc, senders, state, pairEpoch)
  // remain byte-identical references before and after this call.
  async function handleNewcomerInstructions(
    inputs: ReadonlyArray<PairNegotiationInstructionInput>,
  ): Promise<MeshPairContext[]> {
    const out: MeshPairContext[] = [];
    for (const input of inputs) {
      const existing = pairs.get(input.pairId);
      if (existing && existing.pairEpoch === input.pairEpoch) {
        // Already known at this epoch — no-op (allocateContext logs the
        // duplicate; we skip allocation to avoid double-logging here).
        continue;
      }
      const ctx = await allocateContext(input);
      if (ctx) out.push(ctx);
    }
    return out;
  }

  function getContext(pairId: string): MeshPairContext | undefined {
    return pairs.get(pairId);
  }

  function listContexts(): MeshPairContext[] {
    return Array.from(pairs.values());
  }

  // snapshotContext — returns a freshly-frozen view used by the
  // existing-pair stability test (T053). The shallow copy captures
  // pc / dc / senders references at call time so a later mutation by
  // the manager would be observable as a different object identity.
  function snapshotContext(pairId: string): Readonly<MeshPairContext> | null {
    const ctx = pairs.get(pairId);
    if (!ctx) return null;
    return Object.freeze({
      pairId: ctx.pairId,
      pairEpoch: ctx.pairEpoch,
      role: ctx.role,
      remotePeerId: ctx.remotePeerId,
      remoteAdmissionIndex: ctx.remoteAdmissionIndex,
      pc: ctx.pc,
      dc: ctx.dc,
      senders: ctx.senders,
      state: ctx.state,
    });
  }

  function closeAll(): void {
    for (const ctx of pairs.values()) {
      try {
        ctx.pc.close();
      } catch {
        // ignore — already closed
      }
    }
    pairs.clear();
  }

  return {
    handleNegotiationInstruction: allocateContext,
    handleNewcomerInstructions,
    handlePairOffer,
    handlePairAnswer,
    getContext,
    listContexts,
    snapshotContext,
    closeAll,
  };
}
