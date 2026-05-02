// Per-pairing runtime context shared by the mesh webrtc verbs
// (Phase F5 of the frontend rings refactor — full split).
//
// The verbs (`pair_negotiation.ts`, `pair_trickle.ts`,
// `reconnect.ts`) are free functions over this Ctx. The
// `pair-manager.ts` constructs it once per mount and passes it to
// every verb call.

import type { Dispatch } from "react";
import type { MeshRootAction } from "../state";
import type { MeshPairsAction } from "../state/pairs";
import type { MeshClientMessage } from "../protocol/schema";
import type { MeshPairContext, MeshPairState } from "./pairContext";
import type { MeshLog } from "./log";

export type PairViewPatch = Extract<
  MeshPairsAction,
  { type: "MESH_PAIR_VIEW_PATCHED" }
>["patch"];

// Wire candidate matches the v2 contract `pair_ice_candidate.candidate`
// payload shape (signaling-protocol.md §3.12). The browser's
// RTCIceCandidateInit has `candidate` typed as optional; the contract
// requires a non-empty string. Verbs narrow at the wire boundary.
export interface WireIceCandidate {
  candidate: string;
  sdpMid?: string;
  sdpMLineIndex?: number;
  usernameFragment?: string;
}

export type MeshPeerConnectionFactory = (
  cfg: RTCConfiguration,
) => RTCPeerConnection;

export interface MeshLocalMediaSource {
  getTracks(): MediaStreamTrack[];
  getStream(): MediaStream | null;
}

export interface MeshSignalingSendFn {
  (message: MeshClientMessage): void;
}

export interface MeshDeps {
  readonly roomId: string;
  readonly localPeerId: string;
  readonly dispatch: Dispatch<MeshRootAction>;
  readonly send: MeshSignalingSendFn;
  readonly mediaSource: MeshLocalMediaSource;
  readonly peerConnectionFactory: MeshPeerConnectionFactory;
}

export interface MeshCtx {
  readonly deps: MeshDeps;
  readonly log: MeshLog;
  readonly pairs: Map<string, MeshPairContext>;

  /** Patch the React view for a pair (dataChannelState, connectionState, ...). */
  patchPairView(ctx: MeshPairContext, patch: PairViewPatch): void;

  /** Transition a PairContext FSM state and emit one narration entry. */
  transitionState(
    ctx: MeshPairContext,
    next: MeshPairState,
    summary: string,
  ): void;

  /** Drop an inbound pair_offer / pair_answer with mismatched epoch. */
  logStaleDrop(
    pairId: string,
    receivedEpoch: number,
    currentEpoch: number,
    remotePeerId: string,
    inboundType: "pair_offer" | "pair_answer",
  ): void;
}
