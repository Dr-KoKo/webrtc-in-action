// PeerConnection slice — Phase 7 (data-model §B.4).
//
// Mirrors the four getters of `RTCPeerConnection` so persistent UI
// indicators (FR-022a) can render them without reaching into the PC
// object directly. The `RTCPeerConnection` itself lives in a ref owned
// by `PeerConnectionProvider`; this slice only holds value types.
//
// Phase-7 scope: `signalingState` is the actively-moving field —
// offer/answer negotiation drives `stable → have-local-offer → stable`
// (offerer) or `stable → have-remote-offer → stable` (answerer). The
// ICE / connection getters exist but remain at their initial values
// until Phase 8 wires `onicecandidate` + `onconnectionstatechange`.

export interface PeerConnectionSnapshot {
  readonly connectionState: RTCPeerConnectionState;
  readonly iceConnectionState: RTCIceConnectionState;
  readonly iceGatheringState: RTCIceGatheringState;
  readonly signalingState: RTCSignalingState;
}

export interface PeerConnectionSlice extends PeerConnectionSnapshot {
  // `true` between PEER_CONNECTION_CREATED and PEER_CONNECTION_CLOSED.
  // Lets indicators distinguish "no PC yet" from "PC is new/stable".
  readonly hasConnection: boolean;
}

export const initialPeerConnectionSnapshot: PeerConnectionSnapshot = {
  connectionState: "new",
  iceConnectionState: "new",
  iceGatheringState: "new",
  signalingState: "stable",
};

export const initialPeerConnectionSlice: PeerConnectionSlice = {
  ...initialPeerConnectionSnapshot,
  hasConnection: false,
};

export type PeerConnectionAction =
  | { type: "PEER_CONNECTION_CREATED"; snapshot: PeerConnectionSnapshot }
  | {
      type: "PEER_CONNECTION_STATE_CHANGED";
      snapshot: Partial<PeerConnectionSnapshot>;
    }
  | { type: "PEER_CONNECTION_CLOSED" };

export function peerConnectionReducer(
  state: PeerConnectionSlice,
  action: PeerConnectionAction,
): PeerConnectionSlice {
  switch (action.type) {
    case "PEER_CONNECTION_CREATED":
      return {
        ...state,
        ...action.snapshot,
        hasConnection: true,
      };
    case "PEER_CONNECTION_STATE_CHANGED":
      return { ...state, ...action.snapshot };
    case "PEER_CONNECTION_CLOSED":
      return initialPeerConnectionSlice;
    default: {
      const _exhaustive: never = action;
      void _exhaustive;
      return state;
    }
  }
}
