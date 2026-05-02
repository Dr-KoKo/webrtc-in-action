// Pair-view slice (M7 / T057–T060). Mirrors the live lifecycle state
// of every PairContext owned by the WebRTC manager so React components
// (RemoteTile, MeshCostSummary) can render without holding direct
// references to RTCPeerConnection / RTCDataChannel handles.
//
// The slice is intentionally scoped to display + cost surfaces; the
// authoritative lifecycle still lives on `MeshPairContext` inside
// `pairManager.ts`. The manager dispatches `MESH_PAIR_*` actions whenever
// a pc / dc state changes; the reducer mirrors the new value into the
// matching `MeshPairView`.
//
// `MeshPairView.remoteStream` is the MediaStream attached on
// `pc.ontrack`; the slice holds the live reference (non-serializable,
// stays in memory). React tiles wire it to <video>.srcObject /
// <audio>.srcObject inside an effect.

// Simple wire-shaped role tag. Lives in state/ (Ring 2) per
// specs/frontend-architecture.md §2.4 — the webrtc/ pairContext
// re-exports it so existing pair-side callers don't change paths.
export type MeshPairRole = "offerer" | "answerer";

export type DataChannelDisplayState = RTCDataChannelState | "pending";

export interface MeshPairView {
  readonly pairId: string;
  readonly pairEpoch: number;
  readonly role: MeshPairRole;
  readonly remotePeerId: string;
  readonly remoteAdmissionIndex: number;
  readonly connectionState: RTCPeerConnectionState;
  readonly iceConnectionState: RTCIceConnectionState;
  readonly iceGatheringState: RTCIceGatheringState;
  readonly signalingState: RTCSignalingState;
  readonly dataChannelState: DataChannelDisplayState;
  readonly remoteStream: MediaStream | null;
  // M11 — true after the local peer dispatched `reconnect_pair` and
  // before the server's response (instruction or error) for this pair.
  // The Reconnect button uses this to disable itself.
  readonly reconnectRequested: boolean;
}

export interface MeshPairsSlice {
  readonly byPairId: Readonly<Record<string, MeshPairView>>;
}

export const initialMeshPairsSlice: MeshPairsSlice = {
  byPairId: {},
};

export type MeshPairsAction =
  | {
      type: "MESH_PAIR_REGISTERED";
      pairId: string;
      pairEpoch: number;
      role: MeshPairRole;
      remotePeerId: string;
      remoteAdmissionIndex: number;
    }
  | {
      type: "MESH_PAIR_VIEW_PATCHED";
      pairId: string;
      patch: Partial<
        Pick<
          MeshPairView,
          | "connectionState"
          | "iceConnectionState"
          | "iceGatheringState"
          | "signalingState"
          | "dataChannelState"
          | "remoteStream"
          | "reconnectRequested"
        >
      >;
    }
  | { type: "MESH_PAIR_REMOVED"; pairId: string }
  | { type: "MESH_PAIRS_RESET" };

export function meshPairsReducer(
  state: MeshPairsSlice,
  action: MeshPairsAction,
): MeshPairsSlice {
  switch (action.type) {
    case "MESH_PAIR_REGISTERED": {
      if (state.byPairId[action.pairId]) return state;
      const view: MeshPairView = {
        pairId: action.pairId,
        pairEpoch: action.pairEpoch,
        role: action.role,
        remotePeerId: action.remotePeerId,
        remoteAdmissionIndex: action.remoteAdmissionIndex,
        connectionState: "new",
        iceConnectionState: "new",
        iceGatheringState: "new",
        signalingState: "stable",
        dataChannelState: "pending",
        remoteStream: null,
        reconnectRequested: false,
      };
      return {
        byPairId: { ...state.byPairId, [action.pairId]: view },
      };
    }
    case "MESH_PAIR_VIEW_PATCHED": {
      const existing = state.byPairId[action.pairId];
      if (!existing) return state;
      const merged: MeshPairView = { ...existing, ...action.patch };
      return {
        byPairId: { ...state.byPairId, [action.pairId]: merged },
      };
    }
    case "MESH_PAIR_REMOVED": {
      if (!state.byPairId[action.pairId]) return state;
      const { [action.pairId]: _drop, ...rest } = state.byPairId;
      return { byPairId: rest };
    }
    case "MESH_PAIRS_RESET":
      return initialMeshPairsSlice;
    default:
      return state;
  }
}

export function selectPairsAsArray(slice: MeshPairsSlice): MeshPairView[] {
  return Object.values(slice.byPairId).sort(
    (a, b) => a.remoteAdmissionIndex - b.remoteAdmissionIndex,
  );
}

export function selectPairByRemotePeerId(
  slice: MeshPairsSlice,
  remotePeerId: string,
): MeshPairView | undefined {
  for (const v of Object.values(slice.byPairId)) {
    if (v.remotePeerId === remotePeerId) return v;
  }
  return undefined;
}
