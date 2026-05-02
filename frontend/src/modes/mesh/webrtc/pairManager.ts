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
} from "../protocol/schema";
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
import { getActiveScreenTrack } from "./screenShare";

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
export interface PairReconnectInstructionInput {
  readonly pairId: string;
  readonly pairEpoch: number;
  readonly role: MeshPairRole;
  readonly remotePeerId: string;
  readonly remoteAdmissionIndex: number;
  readonly iceServers: RTCIceServer[];
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
  // M11 — inbound pair_failed (relay from the remote endpoint). Marks
  // ONLY the matching PairContext failed; never touches other pairs.
  readonly handlePairFailed: (input: PairFailedInput) => void;
  // M11 — inbound pair_reconnect_instruction. Tears down the existing
  // PairContext for `pairId` (closes DC, closes PC, drops refs, clears
  // iceBuffer), then allocates a fresh PairContext under the new
  // pairEpoch and re-runs the M6 offer/answer flow. Other PairContexts
  // are untouched.
  readonly handlePairReconnectInstruction: (
    input: PairReconnectInstructionInput,
  ) => Promise<MeshPairContext | null>;
  // M11 — request server-side reconnect for a single failed pair. Sends
  // `reconnect_pair { pairId, observedEpoch }` over /ws/mesh, sets
  // `reconnectRequested` on the pair view (button uses this to disable
  // itself), and appends a `peer pair reconnect requested` event.
  readonly reconnectPair: (pairId: string) => void;
  // M11 — clear the in-flight reconnect flag for a specific pair after
  // the server replies with an error (`stale_pair_epoch`, etc.). Called
  // by the dispatcher's error arm when `context.pairId` is present.
  readonly clearReconnectRequested: (pairId: string) => void;
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
  // M12 / T090 — Path B: close only the PairContext local↔remotePeerId
  // (DC, PC, iceBuffer) and drop the pair view. Idempotent — calling
  // twice (e.g. on `peer_left` then on `mesh_roster_update presence=left`)
  // is a no-op. Other PairContexts are NOT touched. Local tracks keep
  // running. Returns true when a pair was found and closed, false when
  // no pair existed for the supplied remote peer id.
  readonly closePairByRemotePeerId: (remotePeerId: string) => boolean;
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
  //
  // M11: when called via `handlePairReconnectInstruction`, `mode` is
  // "reconnect" and the caller has already torn down the previous
  // PairContext for `pairId`. The mode flag selects the outgoing video
  // source (current screen track if active, else camera) and skips the
  // duplicate-instruction short-circuit.
  async function allocateContext(
    input: PairNegotiationInstructionInput,
    mode: "fresh" | "reconnect" = "fresh",
  ): Promise<MeshPairContext | null> {
    const existing = pairs.get(input.pairId);
    if (existing && mode === "fresh") {
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
      // A higher epoch is a reconnect — but it should arrive as
      // pair_reconnect_instruction, not pair_negotiation_instruction.
      // Treat as a protocol nit; log and bail without mutating existing
      // state so we don't accidentally tear down a live pair.
      appendEvent({
        scope: "pair",
        type: "future_phase_message",
        summary: `pair_negotiation_instruction with higher epoch arrived for live pair — ignored (use pair_reconnect_instruction)`,
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
    const allTracks = deps.mediaSource.getTracks();
    const senders: RTCRtpSender[] = [];
    const addOne = (track: MediaStreamTrack): void => {
      const sender = stream
        ? pc.addTrack(track, stream)
        : pc.addTrack(track);
      senders.push(sender);
    };
    // For initial allocation we attach every track the local stream
    // exposes (M6 contract). For M11 reconnect we re-attach audio
    // tracks as-is and substitute the outgoing video source: an
    // active screen-share track if one is published (T085 step 11),
    // otherwise the local camera track (or none when the camera is
    // off / unavailable, producing the camera-off placeholder on
    // remote tiles).
    if (mode === "fresh") {
      for (const t of allTracks) addOne(t);
    } else {
      const audioTracks = allTracks.filter((t) => t.kind === "audio");
      const videoTracks = allTracks.filter((t) => t.kind === "video");
      for (const t of audioTracks) addOne(t);
      const screenTrack = getActiveScreenTrack();
      if (screenTrack) {
        addOne(screenTrack);
      } else {
        for (const t of videoTracks) addOne(t);
      }
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
      failedReported: false,
      reconnectRequested: false,
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
      // M11 / T081 — local detection of pair failure.
      // Mark ONLY this PairContext failed, emit one outbound
      // `pair_failed` envelope, append the canonical event-log entry.
      // Other PairContexts, local media tracks, and DataChannels for
      // healthy pairs are all left untouched (FR-025). Auto-reconnect
      // is explicitly out of scope — the user must click Reconnect.
      if (value === "failed" && !ctx.failedReported) {
        ctx.failedReported = true;
        ctx.state = "failed";
        emitOutboundPairFailed(ctx, "connection_state_failed", "connectionState=failed");
      }
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

  // M11 / T081 — emit one outbound `pair_failed` envelope to the other
  // endpoint of the pair. Idempotent at the per-attempt level via
  // `ctx.failedReported`; the caller checks-and-sets that flag.
  function emitOutboundPairFailed(
    ctx: MeshPairContext,
    reason: PairFailedReason,
    detail: string,
  ): void {
    try {
      deps.send({
        v: MESH_CONTRACT_VERSION,
        type: "pair_failed",
        roomId: deps.roomId,
        to: ctx.remotePeerId,
        payload: {
          pairId: ctx.pairId,
          pairEpoch: ctx.pairEpoch,
          reason,
          detail,
        },
      });
    } catch (err) {
      appendEvent({
        scope: "local",
        type: "signaling_error",
        summary: `failed to send pair_failed for pair ${ctx.pairId}: ${
          (err as Error).message ?? "unknown"
        }`,
      });
    }
    appendEvent({
      scope: "pair",
      type: "future_phase_message",
      summary: `peer pair failed (pair ${ctx.pairId}, reason=${reason})`,
      peerId: ctx.remotePeerId,
      pairId: ctx.pairId,
      detail: {
        kind: "peer_pair_failed",
        direction: "local",
        pairId: ctx.pairId,
        remotePeerId: ctx.remotePeerId,
        reason,
        detailText: detail,
        connectionState: "failed",
        pairEpoch: ctx.pairEpoch,
      },
    });
  }

  // M11 / T081 — inbound `pair_failed` from the remote endpoint (server
  // relays C→S→C). Marks ONLY the matching PairContext failed; never
  // touches other PairContexts, the local roster, or media tracks.
  // Stale pairEpoch is dropped + logged (`stale_pair_message_dropped`).
  function handlePairFailed(input: PairFailedInput): void {
    const ctx = pairs.get(input.pairId);
    if (!ctx) {
      appendEvent({
        scope: "room",
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
    if (input.pairEpoch !== ctx.pairEpoch) {
      appendEvent({
        scope: "pair",
        type: "future_phase_message",
        summary: `pair_stale_message_dropped: pair_failed for pair ${ctx.pairId} (received epoch=${input.pairEpoch}, current=${ctx.pairEpoch})`,
        peerId: ctx.remotePeerId,
        pairId: ctx.pairId,
        detail: {
          kind: "pair_stale_message_dropped",
          direction: "remote",
          inboundType: "pair_failed",
          receivedEpoch: input.pairEpoch,
          currentEpoch: ctx.pairEpoch,
        },
      });
      return;
    }
    ctx.state = "failed";
    ctx.failedReported = true;
    patchPairView(ctx, { connectionState: "failed" });
    appendEvent({
      scope: "pair",
      type: "future_phase_message",
      summary: `peer pair failed (received from remote, pair ${ctx.pairId}, reason=${input.reason})`,
      peerId: ctx.remotePeerId,
      pairId: ctx.pairId,
      detail: {
        kind: "peer_pair_failed",
        direction: "remote",
        pairId: ctx.pairId,
        remotePeerId: ctx.remotePeerId,
        reason: input.reason,
        detailText: input.detail,
        connectionState: "failed",
        pairEpoch: ctx.pairEpoch,
      },
    });
  }

  // M11 / T083 — user clicked Reconnect on a failed remote tile. Sends
  // exactly one `reconnect_pair { pairId, observedEpoch }` to the
  // server; the manager flips `reconnectRequested` so the button
  // disables itself until the server replies (with
  // pair_reconnect_instruction OR a pair-scoped error). Idempotent —
  // a second click while a request is in flight is a no-op.
  function reconnectPair(pairId: string): void {
    const ctx = pairs.get(pairId);
    if (!ctx) {
      appendEvent({
        scope: "room",
        type: "error_occurred",
        summary: `reconnectPair called for unknown pair ${pairId} — ignored`,
        detail: { kind: "reconnect_pair_unknown_pair", pairId },
      });
      return;
    }
    if (ctx.state !== "failed") {
      appendEvent({
        scope: "pair",
        type: "future_phase_message",
        summary: `reconnectPair ignored: pair ${pairId} not in failed state (state=${ctx.state})`,
        peerId: ctx.remotePeerId,
        pairId,
        detail: {
          kind: "reconnect_pair_not_failed",
          state: ctx.state,
          pairEpoch: ctx.pairEpoch,
        },
      });
      return;
    }
    if (ctx.reconnectRequested) {
      appendEvent({
        scope: "pair",
        type: "future_phase_message",
        summary: `reconnectPair ignored: already in flight for pair ${pairId}`,
        peerId: ctx.remotePeerId,
        pairId,
        detail: {
          kind: "reconnect_pair_in_flight",
          pairEpoch: ctx.pairEpoch,
        },
      });
      return;
    }
    ctx.reconnectRequested = true;
    patchPairView(ctx, { reconnectRequested: true });
    try {
      deps.send({
        v: MESH_CONTRACT_VERSION,
        type: "reconnect_pair",
        roomId: deps.roomId,
        payload: {
          pairId: ctx.pairId,
          observedEpoch: ctx.pairEpoch,
        },
      });
    } catch (err) {
      // Roll the flag back on send failure so the user can retry.
      ctx.reconnectRequested = false;
      patchPairView(ctx, { reconnectRequested: false });
      appendEvent({
        scope: "local",
        type: "signaling_error",
        summary: `failed to send reconnect_pair for pair ${pairId}: ${
          (err as Error).message ?? "unknown"
        }`,
      });
      return;
    }
    appendEvent({
      scope: "pair",
      type: "future_phase_message",
      summary: `peer pair reconnect requested (pair ${pairId}, observedEpoch=${ctx.pairEpoch})`,
      peerId: ctx.remotePeerId,
      pairId,
      detail: {
        kind: "peer_pair_reconnect_requested",
        observedEpoch: ctx.pairEpoch,
      },
    });
  }

  function clearReconnectRequested(pairId: string): void {
    const ctx = pairs.get(pairId);
    if (!ctx) return;
    if (!ctx.reconnectRequested) return;
    ctx.reconnectRequested = false;
    patchPairView(ctx, { reconnectRequested: false });
  }

  // M11 / T085 — server replied with pair_reconnect_instruction. Tear
  // down ONLY the affected pair (close DC, close PC, drop refs, clear
  // iceBuffer) and rebuild a fresh PairContext under the new pairEpoch.
  // Local MediaStreamTracks keep running; other PairContexts are
  // strictly untouched (FR-025 / L18). The fresh PairContext re-runs
  // the M6/M7 lifecycle for that pair.
  async function handlePairReconnectInstruction(
    input: PairReconnectInstructionInput,
  ): Promise<MeshPairContext | null> {
    const existing = pairs.get(input.pairId);
    if (!existing) {
      // No prior context — the server should not normally emit a
      // reconnect_instruction for a pair we never had, but allocate
      // defensively under the new epoch so the lifecycle still runs.
      appendEvent({
        scope: "pair",
        type: "future_phase_message",
        summary: `pair_reconnect_instruction for unknown pair ${input.pairId} — allocating fresh PairContext`,
        peerId: input.remotePeerId,
        pairId: input.pairId,
        detail: {
          kind: "pair_reconnect_instruction_no_prior",
          newEpoch: input.pairEpoch,
        },
      });
      const fresh = await allocateContext(input, "reconnect");
      return fresh;
    }
    if (input.pairEpoch <= existing.pairEpoch) {
      appendEvent({
        scope: "pair",
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
    appendEvent({
      scope: "pair",
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
    appendEvent({
      scope: "pair",
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
    // MESH_PAIR_REGISTERED dispatched inside allocateContext (which is
    // idempotent for an existing pairId — see meshPairsReducer).
    deps.dispatch({ type: "MESH_PAIR_REMOVED", pairId: input.pairId });
    const fresh = await allocateContext(input, "reconnect");
    if (fresh) {
      appendEvent({
        scope: "pair",
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
      failedReported: ctx.failedReported,
      reconnectRequested: ctx.reconnectRequested,
    });
  }

  function closeAll(): void {
    for (const ctx of pairs.values()) {
      try {
        ctx.dc?.close();
      } catch {
        // ignore — already closed / never opened
      }
      try {
        ctx.pc.close();
      } catch {
        // ignore — already closed
      }
      ctx.iceBuffer.clear();
      ctx.state = "closed";
      deps.dispatch({ type: "MESH_PAIR_REMOVED", pairId: ctx.pairId });
    }
    pairs.clear();
  }

  function closePairByRemotePeerId(remotePeerId: string): boolean {
    let target: MeshPairContext | undefined;
    for (const ctx of pairs.values()) {
      if (ctx.remotePeerId === remotePeerId) {
        target = ctx;
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
    handleNegotiationInstruction: (input) => allocateContext(input, "fresh"),
    handleNewcomerInstructions,
    handlePairOffer,
    handlePairAnswer,
    handlePairIceCandidate,
    handlePairFailed,
    handlePairReconnectInstruction,
    reconnectPair,
    clearReconnectRequested,
    getContext,
    listContexts,
    listChatPairs,
    snapshotContext,
    closeAll,
    closePairByRemotePeerId,
  };
}
