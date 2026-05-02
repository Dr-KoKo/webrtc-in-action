// Negotiation verb (Phase D1) — Phase 7 (T051–T054) + Phase 8 PC
// lifecycle wiring + Path C failure transition. Owns:
//
//   handleReadyForOffer  — allocate the RTCPeerConnection + IceBuffer,
//                          attach local tracks, kick off the offer
//                          (offerer) or wait for the offer (answerer).
//   handleOffer          — answerer side: applyOffer, send answer.
//   handleAnswer         — offerer side: applyAnswer.
//   sendOffer / sendAnswer — outbound SDP relays (contract §3.8/§3.9).
//
// Free functions over OneToOneCtx; no React, no provider state.

import type {
  AnswerMessage,
  OfferMessage,
  ReadyForOfferMessage,
} from "../protocol/schema";
import { CONTRACT_VERSION } from "../types/contract";
import type { OneToOneCtx } from "./ctx";
import { createPeerConnection } from "./peer-connection";
import { createIceBuffer } from "./ice-buffer";
import {
  initialInspectorSnapshot,
  summarizeCandidate,
  summarizeIceServers,
  summarizeSdp,
  type LearningInspectorSnapshot,
} from "./learning-inspector";
import { sendIceCandidate } from "./trickle";

export async function handleReadyForOffer(
  ctx: OneToOneCtx,
  msg: ReadyForOfferMessage,
): Promise<void> {
  const { refs, log, dispatch, store, peerConnectionFactory } = ctx;
  const currentSession = refs.session.current.session;
  if (currentSession !== "waiting-for-peer" || refs.handle.current !== null) {
    log.signaling({
      type: "error_occurred",
      direction: "system",
      summary: `unexpected_ready_for_offer (state=${currentSession}${
        refs.handle.current ? ", PC already exists" : ""
      })`,
      code: "unexpected_ready_for_offer",
    });
    return;
  }

  const { role, remotePeer, iceServers: inboundIceServers } = msg.payload;
  const iceServers: RTCIceServer[] = inboundIceServers.map((s) => ({
    urls: s.urls,
    ...(s.username !== undefined ? { username: s.username } : {}),
    ...(s.credential !== undefined ? { credential: s.credential } : {}),
  }));

  log.signaling({
    type: "ready_for_offer_received",
    direction: "remote",
    summary: `ready_for_offer received (role=${role}, remote=${shortenId(remotePeer.peerId)}, iceServers=${iceServers.length})`,
  });

  // Reducer transitions waiting-for-peer → connecting.
  store.getState().markReadyForOffer();

  refs.role.current = role;
  refs.activeRoomId.current = msg.roomId ?? refs.session.current.roomId;

  ctx.setInspector((prev) => ({
    ...prev,
    configured: summarizeIceServers(iceServers),
  }));

  const handle = createPeerConnection({
    iceServers,
    role,
    ...(peerConnectionFactory ? { factory: peerConnectionFactory } : {}),
    onSignalingStateChange: (next) => {
      store.getState().notePeerConnectionStateChanged({ signalingState: next });
      log.system({
        type: "signaling_state_changed",
        direction: "local",
        summary: `signalingState → ${next}`,
      });
    },
    onConnectionStateChange: (next) => {
      store.getState().notePeerConnectionStateChanged({ connectionState: next });
      log.system({
        type: "peer_connection_state_changed",
        direction: "local",
        summary: `connectionState → ${next}`,
      });
      if (next === "connected" && refs.session.current.session === "connecting") {
        store.getState().markConnectionEstablished();
      }
      // Path C — local PC failure. Enter `failed`, tear down the PC /
      // DC / remote state, but keep local tracks + WS alive.
      if (
        next === "failed" &&
        (refs.session.current.session === "connecting" ||
          refs.session.current.session === "connected")
      ) {
        store.getState().markConnectionFailed();
        store.getState().clearRemoteMediaState();
        log.system({
          type: "error_occurred",
          direction: "local",
          summary: "connection failed — manual Leave or Rejoin",
          code: "ice_failure",
        });
        ctx.teardownPeerConnection("local_failure");
        log.system({
          type: "cleanup_completed",
          direction: "system",
          summary: "cleanup completed (path=local_failure)",
          code: "local_failure",
        });
      }
    },
    onIceConnectionStateChange: (next) => {
      store.getState().notePeerConnectionStateChanged({ iceConnectionState: next });
      log.system({
        type: "peer_connection_state_changed",
        direction: "local",
        summary: `iceConnectionState → ${next}`,
      });
    },
    onIceGatheringStateChange: (next) => {
      store.getState().notePeerConnectionStateChanged({ iceGatheringState: next });
      log.system({
        type: "peer_connection_state_changed",
        direction: "local",
        summary: `iceGatheringState → ${next}`,
      });
    },
    onIceCandidate: (cand) => {
      sendIceCandidate(ctx, cand);
      if (cand === null) {
        ctx.setInspector((prev) => ({
          ...prev,
          observed: { ...prev.observed, endOfLocalCandidates: true },
        }));
        return;
      }
      const summary = summarizeCandidate(cand);
      ctx.setInspector((prev) => ({
        ...prev,
        observed: tallyCandidate(prev.observed, summary.type),
      }));
    },
    onTrack: (ev) => {
      let aggregate = refs.remoteStream.current;
      if (!aggregate) {
        aggregate = new MediaStream();
        refs.remoteStream.current = aggregate;
      }
      if (!aggregate.getTracks().some((t) => t.id === ev.track.id)) {
        aggregate.addTrack(ev.track);
      }
      ctx.bumpRemoteVersion();
      log.system({
        type: "remote_track_received",
        direction: "remote",
        summary: `remote track received (kind=${ev.track.kind}, id=${shortenId(ev.track.id)})`,
      });
    },
    ...(role === "answerer"
      ? {
          onDataChannel: (dc: RTCDataChannel) => {
            log.datachannel({
              type: "data_channel_created",
              direction: "remote",
              summary: `ondatachannel fired (label="${dc.label}", ordered=${dc.ordered})`,
            });
            ctx.attachChatDataChannel(dc, "answerer");
          },
        }
      : {}),
  });
  refs.handle.current = handle;

  refs.iceBuffer.current = createIceBuffer({
    target: {
      addIceCandidate: (c) => handle.addRemoteIceCandidate(c),
    },
    onError: (err, _c) => {
      log.system({
        type: "error_occurred",
        direction: "local",
        summary: `addIceCandidate failed: ${(err as Error).message ?? "unknown"}`,
        code: "add_ice_candidate_failed",
      });
    },
  });

  store.getState().noteConnectionCreated(handle.getSnapshot());
  log.system({
    type: "peer_connection_created",
    direction: "local",
    summary: `RTCPeerConnection created (role=${role}, iceServers=${iceServers.length})`,
  });

  const stream = refs.getLocalStream.current();
  if (!stream) {
    log.system({
      type: "error_occurred",
      direction: "local",
      summary:
        "peer_connection_created without a local MediaStream — attach skipped",
      code: "missing_local_stream",
    });
  } else {
    handle.attachLocalTracks(stream);
  }

  if (role === "offerer") {
    const dc = handle.createChatDataChannel();
    log.datachannel({
      type: "data_channel_created",
      direction: "local",
      summary: `createDataChannel("chat") (ordered=${dc.ordered})`,
    });
    ctx.attachChatDataChannel(dc, "offerer");
    try {
      const offer = await handle.createOffer();
      log.system({
        type: "offer_created",
        direction: "local",
        summary: `createOffer ok (sdpBytes=${offer.sdp?.length ?? 0}, ${mLineSummary(offer.sdp)})`,
      });
      ctx.setInspector((prev) => ({
        ...prev,
        local: summarizeSdp({ type: "offer", sdp: offer.sdp ?? "" }),
      }));
      sendOffer(ctx, msg.roomId, offer);
    } catch (err) {
      log.system({
        type: "error_occurred",
        direction: "local",
        summary: `createOffer failed: ${(err as Error).message ?? "unknown"}`,
        code: "create_offer_failed",
      });
    }
  }
  // Reference the dispatch shim so unused-binding linting doesn't fire
  // before the next phase migrates remaining sites away from it.
  void dispatch;
}

export async function handleOffer(
  ctx: OneToOneCtx,
  msg: OfferMessage,
): Promise<void> {
  const { refs, log } = ctx;
  const handle = refs.handle.current;
  if (!handle) {
    log.signaling({
      type: "error_occurred",
      direction: "remote",
      summary: "offer received before ready_for_offer; ignoring",
      code: "unexpected_offer",
    });
    return;
  }
  if (handle.role !== "answerer") {
    log.signaling({
      type: "error_occurred",
      direction: "remote",
      summary: `offer received but role=${handle.role}; ignoring`,
      code: "unexpected_offer",
    });
    return;
  }

  log.signaling({
    type: "offer_received",
    direction: "remote",
    summary: `offer received (sdpBytes=${msg.payload.sdp.sdp.length}, ${mLineSummary(msg.payload.sdp.sdp)})`,
  });

  try {
    const answer = await handle.applyOffer(msg.payload.sdp);
    await refs.iceBuffer.current?.markRemoteDescriptionSet();
    ctx.setInspector((prev) => ({
      ...prev,
      remote: summarizeSdp({ type: "offer", sdp: msg.payload.sdp.sdp }),
      local: summarizeSdp({ type: "answer", sdp: answer.sdp ?? "" }),
    }));
    log.system({
      type: "answer_created",
      direction: "local",
      summary: `createAnswer ok (sdpBytes=${answer.sdp?.length ?? 0}, ${mLineSummary(answer.sdp)})`,
    });
    sendAnswer(ctx, msg.roomId, answer);
  } catch (err) {
    log.system({
      type: "error_occurred",
      direction: "local",
      summary: `applyOffer failed: ${(err as Error).message ?? "unknown"}`,
      code: "apply_offer_failed",
    });
  }
}

export async function handleAnswer(
  ctx: OneToOneCtx,
  msg: AnswerMessage,
): Promise<void> {
  const { refs, log } = ctx;
  const handle = refs.handle.current;
  if (!handle) {
    log.signaling({
      type: "error_occurred",
      direction: "remote",
      summary: "answer received before ready_for_offer; ignoring",
      code: "unexpected_answer",
    });
    return;
  }
  if (handle.role !== "offerer") {
    log.signaling({
      type: "error_occurred",
      direction: "remote",
      summary: `answer received but role=${handle.role}; ignoring`,
      code: "unexpected_answer",
    });
    return;
  }

  log.signaling({
    type: "answer_received",
    direction: "remote",
    summary: `answer received (sdpBytes=${msg.payload.sdp.sdp.length}, ${mLineSummary(msg.payload.sdp.sdp)})`,
  });

  try {
    await handle.applyAnswer(msg.payload.sdp);
    await refs.iceBuffer.current?.markRemoteDescriptionSet();
    ctx.setInspector((prev) => ({
      ...prev,
      remote: summarizeSdp({ type: "answer", sdp: msg.payload.sdp.sdp }),
    }));
  } catch (err) {
    log.system({
      type: "error_occurred",
      direction: "local",
      summary: `applyAnswer failed: ${(err as Error).message ?? "unknown"}`,
      code: "apply_answer_failed",
    });
  }
}

export function sendOffer(
  ctx: OneToOneCtx,
  roomId: string | undefined,
  offer: RTCSessionDescriptionInit,
): void {
  const { refs, client, log } = ctx;
  const target = roomId ?? refs.session.current.roomId ?? null;
  if (!target) return;
  if (!offer.sdp) return;
  try {
    client.send({
      v: CONTRACT_VERSION,
      type: "offer",
      roomId: target,
      payload: { sdp: { type: "offer", sdp: offer.sdp } },
    });
    log.signaling({
      type: "offer_sent",
      direction: "local",
      summary: `offer sent (sdpBytes=${offer.sdp.length})`,
    });
  } catch (err) {
    log.signaling({
      type: "error_occurred",
      direction: "local",
      summary: `send offer failed: ${(err as Error).message ?? "unknown"}`,
      code: "send_offer_failed",
    });
  }
}

export function sendAnswer(
  ctx: OneToOneCtx,
  roomId: string | undefined,
  answer: RTCSessionDescriptionInit,
): void {
  const { refs, client, log } = ctx;
  const target = roomId ?? refs.session.current.roomId ?? null;
  if (!target) return;
  if (!answer.sdp) return;
  try {
    client.send({
      v: CONTRACT_VERSION,
      type: "answer",
      roomId: target,
      payload: { sdp: { type: "answer", sdp: answer.sdp } },
    });
    log.signaling({
      type: "answer_sent",
      direction: "local",
      summary: `answer sent (sdpBytes=${answer.sdp.length})`,
    });
  } catch (err) {
    log.signaling({
      type: "error_occurred",
      direction: "local",
      summary: `send answer failed: ${(err as Error).message ?? "unknown"}`,
      code: "send_answer_failed",
    });
  }
}

// Re-exported so callers (the provider) can access initialInspectorSnapshot
// from the verb-files entry-point.
export { initialInspectorSnapshot };
export type { LearningInspectorSnapshot };

function shortenId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

function mLineSummary(sdp: string | undefined): string {
  if (!sdp) return "no-sdp";
  const kinds: string[] = [];
  if (/^m=audio /m.test(sdp)) kinds.push("audio");
  if (/^m=video /m.test(sdp)) kinds.push("video");
  if (/^m=application /m.test(sdp)) kinds.push("data");
  return kinds.length === 0 ? "no-m-lines" : `m=${kinds.join("+")}`;
}

function tallyCandidate(
  prev: LearningInspectorSnapshot["observed"],
  type: ReturnType<typeof summarizeCandidate>["type"],
): LearningInspectorSnapshot["observed"] {
  switch (type) {
    case "host":
      return { ...prev, hostCandidates: prev.hostCandidates + 1 };
    case "srflx":
      return { ...prev, srflxCandidates: prev.srflxCandidates + 1 };
    case "prflx":
      return { ...prev, prflxCandidates: prev.prflxCandidates + 1 };
    case "relay":
      return { ...prev, relayCandidates: prev.relayCandidates + 1 };
    default:
      return prev;
  }
}
