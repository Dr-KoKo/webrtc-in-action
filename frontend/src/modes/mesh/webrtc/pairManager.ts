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
  attachMeshChatReceiver,
  createOffererDataChannel,
} from "./dataChannel";
import type {
  MeshPairContext,
  MeshPairRole,
  MeshPairState,
} from "./pairContext";
import { createIceBuffer, type BufferedIceCandidate } from "./iceBuffer";
import type { MeshPairsAction } from "../state/pairs";

type PairViewPatch = Extract<
  MeshPairsAction,
  { type: "MESH_PAIR_VIEW_PATCHED" }
>["patch"];

// WireIceCandidate matches the v2 contract `pair_ice_candidate.candidate`
// payload shape (signaling-protocol.md §3.12). The browser's
// RTCIceCandidateInit has `candidate` typed as optional; the contract
// requires a non-empty string. We narrow at the wire boundary.
interface WireIceCandidate {
  candidate: string;
  sdpMid?: string;
  sdpMLineIndex?: number;
  usernameFragment?: string;
}

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

export interface PairIceCandidateInput {
  readonly pairId: string;
  readonly pairEpoch: number;
  // `null` = end-of-candidates (contract §3.12).
  readonly candidate: RTCIceCandidateInit | null;
}

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
  readonly getContext: (pairId: string) => MeshPairContext | undefined;
  readonly listContexts: () => MeshPairContext[];
  // listChatPairs — sender-facing snapshot of pair_id / remote_peer_id /
  // dc references at call time. Used by `MeshChat` to fan one chat
  // message out across every active pair (M8). Includes pairs whose
  // `dc` is `null` or whose `dc.readyState !== "open"`; the sender
  // helper records those as skipped.
  readonly listChatPairs: () => MeshChatSendablePairView[];
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
      iceBuffer: createIceBuffer(),
      remoteDescriptionApplied: false,
      endOfLocalCandidatesSent: false,
      endOfRemoteCandidatesReceived: false,
    };
    pairs.set(ctx.pairId, ctx);

    // Register the pair view in the React store BEFORE we wire any
    // listener that might dispatch a patch (handlers fire synchronously
    // on some browsers as soon as setLocalDescription mutates state).
    deps.dispatch({
      type: "MESH_PAIR_REGISTERED",
      pairId: ctx.pairId,
      pairEpoch: ctx.pairEpoch,
      role: ctx.role,
      remotePeerId: ctx.remotePeerId,
      remoteAdmissionIndex: ctx.remoteAdmissionIndex,
    });

    pc.onsignalingstatechange = () => {
      const value = pc.signalingState;
      appendEvent({
        scope: "pair",
        type: "future_phase_message",
        summary: `signaling state changed → ${value} (pair ${ctx.pairId})`,
        peerId: ctx.remotePeerId,
        pairId: ctx.pairId,
        detail: {
          kind: "signaling_state_change",
          direction: "system",
          signalingState: value,
          pairEpoch: ctx.pairEpoch,
        },
      });
      patchPairView(ctx, { signalingState: value });
      if (value === "stable" && ctx.state !== "stable") {
        ctx.state = "stable";
      }
    };

    pc.oniceconnectionstatechange = () => {
      const value = pc.iceConnectionState;
      appendEvent({
        scope: "pair",
        type: "future_phase_message",
        summary: `ICE state changed → ${value} (pair ${ctx.pairId})`,
        peerId: ctx.remotePeerId,
        pairId: ctx.pairId,
        detail: {
          kind: "ice_connection_state_change",
          direction: "system",
          iceConnectionState: value,
          pairEpoch: ctx.pairEpoch,
        },
      });
      patchPairView(ctx, { iceConnectionState: value });
    };

    pc.onicegatheringstatechange = () => {
      const value = pc.iceGatheringState;
      appendEvent({
        scope: "pair",
        type: "future_phase_message",
        summary: `ICE gathering state changed → ${value} (pair ${ctx.pairId})`,
        peerId: ctx.remotePeerId,
        pairId: ctx.pairId,
        detail: {
          kind: "ice_gathering_state_change",
          direction: "system",
          iceGatheringState: value,
          pairEpoch: ctx.pairEpoch,
        },
      });
      patchPairView(ctx, { iceGatheringState: value });
    };

    pc.onconnectionstatechange = () => {
      const value = pc.connectionState;
      appendEvent({
        scope: "pair",
        type: "future_phase_message",
        summary: `connection state changed → ${value} (pair ${ctx.pairId})`,
        peerId: ctx.remotePeerId,
        pairId: ctx.pairId,
        detail: {
          kind: "connection_state_change",
          direction: "system",
          connectionState: value,
          pairEpoch: ctx.pairEpoch,
        },
      });
      patchPairView(ctx, { connectionState: value });
    };

    pc.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
      // event.candidate === null is the canonical end-of-candidates
      // signal. We forward it to the remote as `candidate: null` per
      // contract §3.12. We MUST NOT emit `candidate: ""`; the browser
      // shouldn't produce that, but if `toJSON` somehow returns an
      // empty `candidate` string we drop the event defensively.
      if (!event.candidate) {
        sendLocalCandidate(ctx, null);
        return;
      }
      const init = event.candidate.toJSON();
      if (!init.candidate) {
        return;
      }
      const wire: WireIceCandidate = { candidate: init.candidate };
      if (init.sdpMid !== undefined && init.sdpMid !== null) {
        wire.sdpMid = init.sdpMid;
      }
      if (init.sdpMLineIndex !== undefined && init.sdpMLineIndex !== null) {
        wire.sdpMLineIndex = init.sdpMLineIndex;
      }
      if (
        init.usernameFragment !== undefined &&
        init.usernameFragment !== null
      ) {
        wire.usernameFragment = init.usernameFragment;
      }
      sendLocalCandidate(ctx, wire);
    };

    pc.ontrack = (event: RTCTrackEvent) => {
      const stream = event.streams && event.streams[0] ? event.streams[0] : null;
      const trackKind = event.track?.kind ?? "unknown";
      appendEvent({
        scope: "pair",
        type: "future_phase_message",
        summary: `remote track received (${trackKind}, pair ${ctx.pairId})`,
        peerId: ctx.remotePeerId,
        pairId: ctx.pairId,
        detail: {
          kind: "remote_track_received",
          direction: "remote",
          trackKind,
          pairEpoch: ctx.pairEpoch,
        },
      });
      if (stream) {
        patchPairView(ctx, { remoteStream: stream });
      }
    };

    if (ctx.role === "offerer") {
      // FR-050 — DataChannel MUST be created before the offer so the
      // SDP carries the data m-line.
      const dc = createOffererDataChannel(ctx);
      wireDataChannelLifecycle(ctx, dc);
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
            direction: "remote",
            label: dc.label,
            readyState: dc.readyState,
          },
        });
        wireDataChannelLifecycle(ctx, dc);
      });
    }

    return ctx;
  }

  function patchPairView(ctx: MeshPairContext, patch: PairViewPatch): void {
    deps.dispatch({
      type: "MESH_PAIR_VIEW_PATCHED",
      pairId: ctx.pairId,
      patch,
    });
  }

  // wireDataChannelLifecycle — emit DataChannel state-change events
  // and patch the pair view's `dataChannelState` pill. M8 also
  // attaches the chat `onmessage` handler here so receive plumbing is
  // active as soon as the channel reference exists (the handler is
  // idempotent at the dc-instance level — see `attachMeshChatReceiver`).
  function wireDataChannelLifecycle(
    ctx: MeshPairContext,
    dc: RTCDataChannel,
  ): void {
    patchPairView(ctx, { dataChannelState: dc.readyState });
    attachMeshChatReceiver(dc, {
      dispatch: deps.dispatch,
      pairId: ctx.pairId,
      remotePeerId: ctx.remotePeerId,
      expectedRoomId: deps.roomId,
    });
    const refresh = (eventLabel: string) => {
      const value = dc.readyState;
      appendEvent({
        scope: "pair",
        type: "future_phase_message",
        summary: `${eventLabel} → ${value} (pair ${ctx.pairId})`,
        peerId: ctx.remotePeerId,
        pairId: ctx.pairId,
        detail: {
          kind: "data_channel_state_change",
          direction: "system",
          event: eventLabel,
          dataChannelState: value,
          pairEpoch: ctx.pairEpoch,
        },
      });
      patchPairView(ctx, { dataChannelState: value });
    };
    dc.onopen = () => refresh("DataChannel opened");
    dc.onclose = () => refresh("DataChannel closed");
    dc.onclosing = () => refresh("DataChannel closing");
    dc.onerror = () => refresh("DataChannel error");
  }

  function sendLocalCandidate(
    ctx: MeshPairContext,
    candidate: WireIceCandidate | null,
  ): void {
    if (candidate === null) {
      if (ctx.endOfLocalCandidatesSent) return;
      ctx.endOfLocalCandidatesSent = true;
    }
    deps.send({
      v: MESH_CONTRACT_VERSION,
      type: "pair_ice_candidate",
      roomId: deps.roomId,
      to: ctx.remotePeerId,
      payload: {
        pairId: ctx.pairId,
        pairEpoch: ctx.pairEpoch,
        candidate,
      },
    });
    if (candidate === null) {
      appendEvent({
        scope: "pair",
        type: "future_phase_message",
        summary: `ICE end-of-candidates sent (pair ${ctx.pairId})`,
        peerId: ctx.remotePeerId,
        pairId: ctx.pairId,
        detail: {
          kind: "ice_eoc_sent",
          direction: "local",
          pairEpoch: ctx.pairEpoch,
        },
      });
    } else {
      appendEvent({
        scope: "pair",
        type: "future_phase_message",
        summary: `ICE candidate sent (pair ${ctx.pairId})`,
        peerId: ctx.remotePeerId,
        pairId: ctx.pairId,
        detail: {
          kind: "ice_candidate_sent",
          direction: "local",
          pairEpoch: ctx.pairEpoch,
        },
      });
    }
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
    ctx.remoteDescriptionApplied = true;
    await flushIceBuffer(ctx);
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
    ctx.remoteDescriptionApplied = true;
    await flushIceBuffer(ctx);
    if (ctx.pc.signalingState === "stable") {
      ctx.state = "stable";
    }
  }

  async function flushIceBuffer(ctx: MeshPairContext): Promise<void> {
    if (ctx.iceBuffer.size() === 0) return;
    const drained: number[] = [];
    await ctx.iceBuffer.drain(async (cand) => {
      drained.push(0);
      await applyRemoteCandidate(ctx, cand, "flushed");
    });
    appendEvent({
      scope: "pair",
      type: "future_phase_message",
      summary: `ICE buffer flushed (${drained.length} candidate${drained.length === 1 ? "" : "s"}, pair ${ctx.pairId})`,
      peerId: ctx.remotePeerId,
      pairId: ctx.pairId,
      detail: {
        kind: "ice_buffer_flushed",
        direction: "system",
        count: drained.length,
        pairEpoch: ctx.pairEpoch,
      },
    });
  }

  async function applyRemoteCandidate(
    ctx: MeshPairContext,
    candidate: BufferedIceCandidate,
    source: "live" | "flushed",
  ): Promise<void> {
    try {
      // Per W3C, calling addIceCandidate() with no argument signals
      // end-of-candidates. Some browsers also accept an empty object.
      // We pass `undefined` for null so we never emit `candidate: ""`.
      if (candidate === null) {
        await ctx.pc.addIceCandidate();
      } else {
        await ctx.pc.addIceCandidate(candidate);
      }
    } catch (err) {
      appendEvent({
        scope: "pair",
        type: "error_occurred",
        summary: `addIceCandidate failed (pair ${ctx.pairId}, source=${source})`,
        peerId: ctx.remotePeerId,
        pairId: ctx.pairId,
        detail: {
          kind: "ice_candidate_apply_failed",
          direction: "system",
          source,
          pairEpoch: ctx.pairEpoch,
          error: err instanceof Error ? err.message : String(err),
        },
      });
      return;
    }
    if (candidate === null) {
      ctx.endOfRemoteCandidatesReceived = true;
      appendEvent({
        scope: "pair",
        type: "future_phase_message",
        summary: `ICE end-of-candidates received (pair ${ctx.pairId})`,
        peerId: ctx.remotePeerId,
        pairId: ctx.pairId,
        detail: {
          kind: "ice_eoc_received",
          direction: "remote",
          source,
          pairEpoch: ctx.pairEpoch,
        },
      });
    } else {
      appendEvent({
        scope: "pair",
        type: "future_phase_message",
        summary: `ICE candidate received (pair ${ctx.pairId})`,
        peerId: ctx.remotePeerId,
        pairId: ctx.pairId,
        detail: {
          kind: "ice_candidate_received",
          direction: "remote",
          source,
          pairEpoch: ctx.pairEpoch,
        },
      });
    }
  }

  async function handlePairIceCandidate(
    input: PairIceCandidateInput,
  ): Promise<void> {
    const ctx = pairs.get(input.pairId);
    if (!ctx) {
      appendEvent({
        scope: "room",
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
    if (input.pairEpoch !== ctx.pairEpoch) {
      appendEvent({
        scope: "pair",
        type: "future_phase_message",
        summary: `pair_stale_message_dropped: pair_ice_candidate for pair ${ctx.pairId} (received epoch=${input.pairEpoch}, current=${ctx.pairEpoch})`,
        peerId: ctx.remotePeerId,
        pairId: ctx.pairId,
        detail: {
          kind: "pair_stale_message_dropped",
          direction: "remote",
          inboundType: "pair_ice_candidate",
          receivedEpoch: input.pairEpoch,
          currentEpoch: ctx.pairEpoch,
        },
      });
      return;
    }
    if (!ctx.remoteDescriptionApplied) {
      ctx.iceBuffer.push(input.candidate);
      appendEvent({
        scope: "pair",
        type: "future_phase_message",
        summary: input.candidate === null
          ? `ICE end-of-candidates buffered (pair ${ctx.pairId})`
          : `ICE candidate buffered (pair ${ctx.pairId})`,
        peerId: ctx.remotePeerId,
        pairId: ctx.pairId,
        detail: {
          kind: "ice_candidate_buffered",
          direction: "remote",
          endOfCandidates: input.candidate === null,
          pairEpoch: ctx.pairEpoch,
        },
      });
      return;
    }
    await applyRemoteCandidate(ctx, input.candidate, "live");
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

  function listChatPairs(): MeshChatSendablePairView[] {
    return Array.from(pairs.values())
      .sort((a, b) => a.remoteAdmissionIndex - b.remoteAdmissionIndex)
      .map((ctx) => ({
        pairId: ctx.pairId,
        remotePeerId: ctx.remotePeerId,
        dc: ctx.dc,
      }));
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
      iceBuffer: ctx.iceBuffer,
      remoteDescriptionApplied: ctx.remoteDescriptionApplied,
      endOfLocalCandidatesSent: ctx.endOfLocalCandidatesSent,
      endOfRemoteCandidatesReceived: ctx.endOfRemoteCandidatesReceived,
    });
  }

  function closeAll(): void {
    for (const ctx of pairs.values()) {
      try {
        ctx.pc.close();
      } catch {
        // ignore — already closed
      }
      ctx.iceBuffer.clear();
      deps.dispatch({ type: "MESH_PAIR_REMOVED", pairId: ctx.pairId });
    }
    pairs.clear();
  }

  return {
    handleNegotiationInstruction: allocateContext,
    handleNewcomerInstructions,
    handlePairOffer,
    handlePairAnswer,
    handlePairIceCandidate,
    getContext,
    listContexts,
    listChatPairs,
    snapshotContext,
    closeAll,
  };
}
