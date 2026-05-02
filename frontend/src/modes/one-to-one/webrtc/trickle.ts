// Trickle ICE verb (Phase D1) — Phase 8 (T057/T058/T059).
//
//   handleIceCandidate  — inbound remote candidate; routed through the
//                         per-pair IceBuffer so it applies after
//                         setRemoteDescription resolves.
//   sendIceCandidate    — outbound local candidate (incl. end-of-
//                         candidates `null` per contract §3.10).
//
// Free functions over OneToOneCtx; no React, no provider state.

import type { IceCandidateMessage } from "../protocol/schema";
import { CONTRACT_VERSION } from "../types/contract";
import type { OneToOneCtx } from "./ctx";
import { summarizeCandidate, type LearningInspectorSnapshot } from "./learning-inspector";

export async function handleIceCandidate(
  ctx: OneToOneCtx,
  msg: IceCandidateMessage,
): Promise<void> {
  const { refs, log } = ctx;
  const buffer = refs.iceBuffer.current;
  if (!buffer) {
    log.signaling({
      type: "error_occurred",
      direction: "remote",
      summary: "ice_candidate received without an active PC; ignoring",
      code: "unexpected_ice_candidate",
    });
    return;
  }
  const payloadCandidate = msg.payload.candidate;
  if (payloadCandidate === null) {
    log.signaling({
      type: "ice_candidate_received",
      direction: "remote",
      summary: "remote ice_candidate: end-of-candidates",
    });
    ctx.setInspector((prev) => ({
      ...prev,
      observed: { ...prev.observed, endOfRemoteCandidates: true },
    }));
    buffer.add(null);
    return;
  }
  const candInit: RTCIceCandidateInit = {
    candidate: payloadCandidate.candidate,
    ...(payloadCandidate.sdpMid !== undefined
      ? { sdpMid: payloadCandidate.sdpMid }
      : {}),
    ...(payloadCandidate.sdpMLineIndex !== undefined
      ? { sdpMLineIndex: payloadCandidate.sdpMLineIndex }
      : {}),
    ...(payloadCandidate.usernameFragment !== undefined
      ? { usernameFragment: payloadCandidate.usernameFragment }
      : {}),
  };
  const summary = summarizeCandidate(candInit);
  log.signaling({
    type: "ice_candidate_received",
    direction: "remote",
    summary: `remote ice_candidate (${summary.type}/${summary.protocol}${buffer.remoteDescriptionSet ? "" : ", buffered"})`,
  });
  ctx.setInspector((prev) => ({
    ...prev,
    observed: tallyCandidate(prev.observed, summary.type),
  }));
  const apply = buffer.add(candInit);
  if (apply) {
    try {
      await apply;
    } catch {
      // The IceBuffer's onError callback handles the log entry; the
      // buffer swallows the rejection so this caller doesn't need to.
    }
  }
}

export function sendIceCandidate(
  ctx: OneToOneCtx,
  candidate: RTCIceCandidateInit | null,
): void {
  const { refs, client, log } = ctx;
  const target =
    refs.activeRoomId.current ?? refs.session.current.roomId ?? null;
  if (!target) return;
  try {
    client.send({
      v: CONTRACT_VERSION,
      type: "ice_candidate",
      roomId: target,
      payload: {
        candidate:
          candidate === null
            ? null
            : {
                candidate: candidate.candidate ?? "",
                ...(candidate.sdpMid !== undefined && candidate.sdpMid !== null
                  ? { sdpMid: candidate.sdpMid }
                  : {}),
                ...(candidate.sdpMLineIndex !== undefined &&
                candidate.sdpMLineIndex !== null
                  ? { sdpMLineIndex: candidate.sdpMLineIndex }
                  : {}),
                ...(candidate.usernameFragment !== undefined &&
                candidate.usernameFragment !== null
                  ? { usernameFragment: candidate.usernameFragment }
                  : {}),
              },
      },
    });
    if (candidate === null) {
      log.signaling({
        type: "ice_candidate_sent",
        direction: "local",
        summary: "local ice_candidate: end-of-candidates",
      });
    } else {
      const summary = summarizeCandidate(candidate);
      log.signaling({
        type: "ice_candidate_sent",
        direction: "local",
        summary: `local ice_candidate (${summary.type}/${summary.protocol})`,
      });
    }
  } catch (err) {
    log.signaling({
      type: "error_occurred",
      direction: "local",
      summary: `send ice_candidate failed: ${(err as Error).message ?? "unknown"}`,
      code: "send_ice_candidate_failed",
    });
  }
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
