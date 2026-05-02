// Negotiation verbs for mesh (Phase F5).
//
//   allocateContext              — wire a fresh PairContext: build PC,
//                                  attach local tracks, register PC
//                                  callbacks, fire offer or wait for it.
//   wireDataChannelLifecycle     — register DC state-change callbacks +
//                                  attach the chat receiver.
//   emitOffer                    — offerer side: createOffer + send.
//   handlePairOffer              — answerer side: applyOffer + send answer.
//   handlePairAnswer             — offerer side: applyAnswer.
//   handleNewcomerInstructions   — batch allocateContext for fresh pairs;
//                                  existing pairs are byte-stable (FR-022a).
//
// Free functions over MeshCtx; no React, no provider state.

import {
  MESH_CONTRACT_VERSION,
  type MeshClientMessage,
} from "../protocol/schema";
import { createIceBuffer } from "./iceBuffer";
import {
  attachAnswererDataChannelHandler,
  attachMeshChatReceiver,
  createOffererDataChannel,
} from "./dataChannel";
import type {
  MeshPairContext,
  MeshPairRole,
} from "./pairContext";
import { getActiveScreenTrack } from "./screenShare";
import type { MeshCtx, WireIceCandidate } from "./ctx";
import { sendLocalCandidate } from "./pair_trickle";
import {
  emitOutboundPairFailed,
  type PairFailedReason,
} from "./reconnect";
import { flushIceBuffer } from "./pair_trickle";

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

// allocateContext — idempotent per (pairId + pairEpoch). A duplicate
// instruction with the same epoch returns the existing context
// without creating a second pc / dc / sender set. The `mode` flag
// distinguishes initial allocation from F5/M11 reconnect; reconnect
// substitutes the outgoing video source with an active screen-share
// track when one is published (T085 step 11).
export async function allocateContext(
  ctx: MeshCtx,
  input: PairNegotiationInstructionInput,
  mode: "fresh" | "reconnect" = "fresh",
): Promise<MeshPairContext | null> {
  const { deps, log, pairs } = ctx;
  const existing = pairs.get(input.pairId);
  if (existing && mode === "fresh") {
    if (existing.pairEpoch === input.pairEpoch) {
      log.pair({
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
    log.pair({
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

  const pair: MeshPairContext = {
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
  pairs.set(pair.pairId, pair);

  // Register the pair view in the React store BEFORE wiring callbacks
  // that may dispatch a patch synchronously on some browsers.
  deps.dispatch({
    type: "MESH_PAIR_REGISTERED",
    pairId: pair.pairId,
    pairEpoch: pair.pairEpoch,
    role: pair.role,
    remotePeerId: pair.remotePeerId,
    remoteAdmissionIndex: pair.remoteAdmissionIndex,
  });

  pc.onsignalingstatechange = () => {
    const value = pc.signalingState;
    log.pair({
      type: "future_phase_message",
      summary: `signaling state changed → ${value} (pair ${pair.pairId})`,
      peerId: pair.remotePeerId,
      pairId: pair.pairId,
      detail: {
        kind: "signaling_state_change",
        direction: "system",
        signalingState: value,
        pairEpoch: pair.pairEpoch,
      },
    });
    ctx.patchPairView(pair, { signalingState: value });
    if (value === "stable" && pair.state !== "stable") {
      pair.state = "stable";
    }
  };

  pc.oniceconnectionstatechange = () => {
    const value = pc.iceConnectionState;
    log.pair({
      type: "future_phase_message",
      summary: `ICE state changed → ${value} (pair ${pair.pairId})`,
      peerId: pair.remotePeerId,
      pairId: pair.pairId,
      detail: {
        kind: "ice_connection_state_change",
        direction: "system",
        iceConnectionState: value,
        pairEpoch: pair.pairEpoch,
      },
    });
    ctx.patchPairView(pair, { iceConnectionState: value });
  };

  pc.onicegatheringstatechange = () => {
    const value = pc.iceGatheringState;
    log.pair({
      type: "future_phase_message",
      summary: `ICE gathering state changed → ${value} (pair ${pair.pairId})`,
      peerId: pair.remotePeerId,
      pairId: pair.pairId,
      detail: {
        kind: "ice_gathering_state_change",
        direction: "system",
        iceGatheringState: value,
        pairEpoch: pair.pairEpoch,
      },
    });
    ctx.patchPairView(pair, { iceGatheringState: value });
  };

  pc.onconnectionstatechange = () => {
    const value = pc.connectionState;
    log.pair({
      type: "future_phase_message",
      summary: `connection state changed → ${value} (pair ${pair.pairId})`,
      peerId: pair.remotePeerId,
      pairId: pair.pairId,
      detail: {
        kind: "connection_state_change",
        direction: "system",
        connectionState: value,
        pairEpoch: pair.pairEpoch,
      },
    });
    ctx.patchPairView(pair, { connectionState: value });
    // M11 / T081 — local detection of pair failure. Mark ONLY this
    // PairContext failed; auto-reconnect is explicitly out of scope.
    if (value === "failed" && !pair.failedReported) {
      pair.failedReported = true;
      pair.state = "failed";
      const reason: PairFailedReason = "connection_state_failed";
      emitOutboundPairFailed(ctx, pair, reason, "connectionState=failed");
    }
  };

  pc.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
    if (!event.candidate) {
      sendLocalCandidate(ctx, pair, null);
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
    sendLocalCandidate(ctx, pair, wire);
  };

  pc.ontrack = (event: RTCTrackEvent) => {
    const stream = event.streams && event.streams[0] ? event.streams[0] : null;
    const trackKind = event.track?.kind ?? "unknown";
    log.pair({
      type: "future_phase_message",
      summary: `remote track received (${trackKind}, pair ${pair.pairId})`,
      peerId: pair.remotePeerId,
      pairId: pair.pairId,
      detail: {
        kind: "remote_track_received",
        direction: "remote",
        trackKind,
        pairEpoch: pair.pairEpoch,
      },
    });
    if (stream) {
      ctx.patchPairView(pair, { remoteStream: stream });
    }
  };

  if (pair.role === "offerer") {
    // FR-050 — DataChannel MUST be created before the offer so the
    // SDP carries the data m-line.
    const dc = createOffererDataChannel(pair);
    wireDataChannelLifecycle(ctx, pair, dc);
    await emitOffer(ctx, pair);
  } else {
    attachAnswererDataChannelHandler(pair, (dc) => {
      log.pair({
        type: "future_phase_message",
        summary: `data channel attached on answerer (pair ${pair.pairId}, label=${dc.label}, readyState=${dc.readyState})`,
        peerId: pair.remotePeerId,
        pairId: pair.pairId,
        detail: {
          kind: "datachannel_attached",
          direction: "remote",
          label: dc.label,
          readyState: dc.readyState,
        },
      });
      wireDataChannelLifecycle(ctx, pair, dc);
    });
  }

  return pair;
}

// wireDataChannelLifecycle — emit DataChannel state-change events
// and patch the pair view's `dataChannelState` pill. M8 also attaches
// the chat `onmessage` handler here so receive plumbing is active as
// soon as the channel reference exists (the handler is idempotent at
// the dc-instance level — see `attachMeshChatReceiver`).
function wireDataChannelLifecycle(
  ctx: MeshCtx,
  pair: MeshPairContext,
  dc: RTCDataChannel,
): void {
  const { deps, log } = ctx;
  ctx.patchPairView(pair, { dataChannelState: dc.readyState });
  attachMeshChatReceiver(dc, {
    dispatch: deps.dispatch,
    pairId: pair.pairId,
    remotePeerId: pair.remotePeerId,
    expectedRoomId: deps.roomId,
  });
  const refresh = (eventLabel: string) => {
    const value = dc.readyState;
    log.pair({
      type: "future_phase_message",
      summary: `${eventLabel} → ${value} (pair ${pair.pairId})`,
      peerId: pair.remotePeerId,
      pairId: pair.pairId,
      detail: {
        kind: "data_channel_state_change",
        direction: "system",
        event: eventLabel,
        dataChannelState: value,
        pairEpoch: pair.pairEpoch,
      },
    });
    ctx.patchPairView(pair, { dataChannelState: value });
  };
  dc.onopen = () => refresh("DataChannel opened");
  dc.onclose = () => refresh("DataChannel closed");
  dc.onclosing = () => refresh("DataChannel closing");
  dc.onerror = () => refresh("DataChannel error");
}

export async function emitOffer(
  ctx: MeshCtx,
  pair: MeshPairContext,
): Promise<void> {
  const { deps, log } = ctx;
  ctx.transitionState(pair, "creating-offer", "creating offer");
  const offer = await pair.pc.createOffer();
  await pair.pc.setLocalDescription(offer);
  ctx.transitionState(pair, "have-local-offer", "offer created");
  deps.send({
    v: MESH_CONTRACT_VERSION,
    type: "pair_offer",
    roomId: deps.roomId,
    to: pair.remotePeerId,
    payload: {
      pairId: pair.pairId,
      pairEpoch: pair.pairEpoch,
      sdp: { type: "offer", sdp: offer.sdp ?? "" },
    },
  } satisfies MeshClientMessage);
  log.pair({
    type: "future_phase_message",
    summary: `offer sent (pair ${pair.pairId})`,
    peerId: pair.remotePeerId,
    pairId: pair.pairId,
    detail: { kind: "offer_sent", pairEpoch: pair.pairEpoch },
  });
}

export async function handlePairOffer(
  ctx: MeshCtx,
  input: PairOfferInput,
): Promise<void> {
  const { deps, log, pairs } = ctx;
  const pair = pairs.get(input.pairId);
  if (!pair) {
    log.room({
      type: "error_occurred",
      summary: `pair_offer received for unknown pair ${input.pairId} — ignored`,
      detail: { pairId: input.pairId, pairEpoch: input.pairEpoch },
    });
    return;
  }
  if (pair.role !== "answerer") {
    log.pair({
      type: "future_phase_message",
      summary: `pair_offer received but local role=${pair.role} (pair ${pair.pairId}) — ignored`,
      peerId: pair.remotePeerId,
      pairId: pair.pairId,
      detail: { kind: "wrong_role_offer_ignored" },
    });
    return;
  }
  if (input.pairEpoch !== pair.pairEpoch) {
    ctx.logStaleDrop(
      pair.pairId,
      input.pairEpoch,
      pair.pairEpoch,
      pair.remotePeerId,
      "pair_offer",
    );
    return;
  }
  log.pair({
    type: "future_phase_message",
    summary: `offer received (pair ${pair.pairId})`,
    peerId: pair.remotePeerId,
    pairId: pair.pairId,
    detail: { kind: "offer_received", pairEpoch: pair.pairEpoch },
  });
  ctx.transitionState(pair, "have-remote-offer", "offer received");
  await pair.pc.setRemoteDescription(input.sdp);
  pair.remoteDescriptionApplied = true;
  await flushIceBuffer(ctx, pair);
  ctx.transitionState(pair, "creating-answer", "creating answer");
  const answer = await pair.pc.createAnswer();
  await pair.pc.setLocalDescription(answer);
  ctx.transitionState(pair, "have-local-answer", "answer created");
  deps.send({
    v: MESH_CONTRACT_VERSION,
    type: "pair_answer",
    roomId: deps.roomId,
    to: pair.remotePeerId,
    payload: {
      pairId: pair.pairId,
      pairEpoch: pair.pairEpoch,
      sdp: { type: "answer", sdp: answer.sdp ?? "" },
    },
  });
  log.pair({
    type: "future_phase_message",
    summary: `answer sent (pair ${pair.pairId})`,
    peerId: pair.remotePeerId,
    pairId: pair.pairId,
    detail: { kind: "answer_sent", pairEpoch: pair.pairEpoch },
  });
}

export async function handlePairAnswer(
  ctx: MeshCtx,
  input: PairAnswerInput,
): Promise<void> {
  const { log, pairs } = ctx;
  const pair = pairs.get(input.pairId);
  if (!pair) {
    log.room({
      type: "error_occurred",
      summary: `pair_answer received for unknown pair ${input.pairId} — ignored`,
      detail: { pairId: input.pairId, pairEpoch: input.pairEpoch },
    });
    return;
  }
  if (pair.role !== "offerer") {
    log.pair({
      type: "future_phase_message",
      summary: `pair_answer received but local role=${pair.role} (pair ${pair.pairId}) — ignored`,
      peerId: pair.remotePeerId,
      pairId: pair.pairId,
      detail: { kind: "wrong_role_answer_ignored" },
    });
    return;
  }
  if (input.pairEpoch !== pair.pairEpoch) {
    ctx.logStaleDrop(
      pair.pairId,
      input.pairEpoch,
      pair.pairEpoch,
      pair.remotePeerId,
      "pair_answer",
    );
    return;
  }
  log.pair({
    type: "future_phase_message",
    summary: `answer received (pair ${pair.pairId})`,
    peerId: pair.remotePeerId,
    pairId: pair.pairId,
    detail: { kind: "answer_received", pairEpoch: pair.pairEpoch },
  });
  ctx.transitionState(pair, "have-remote-answer", "answer received");
  await pair.pc.setRemoteDescription(input.sdp);
  pair.remoteDescriptionApplied = true;
  await flushIceBuffer(ctx, pair);
  if (pair.pc.signalingState === "stable") {
    pair.state = "stable";
  }
}

// handleNewcomerInstructions — T051 / L18: when a newcomer's
// instructions arrive in a batch, allocate only the new pairs.
// Existing PairContext entries (pc, dc, senders, state, pairEpoch)
// remain byte-identical references before and after this call.
export async function handleNewcomerInstructions(
  ctx: MeshCtx,
  inputs: ReadonlyArray<PairNegotiationInstructionInput>,
): Promise<MeshPairContext[]> {
  const out: MeshPairContext[] = [];
  for (const input of inputs) {
    const existing = ctx.pairs.get(input.pairId);
    if (existing && existing.pairEpoch === input.pairEpoch) {
      // Already known at this epoch — no-op (allocateContext logs the
      // duplicate; we skip allocation to avoid double-logging here).
      continue;
    }
    const pair = await allocateContext(ctx, input);
    if (pair) out.push(pair);
  }
  return out;
}
