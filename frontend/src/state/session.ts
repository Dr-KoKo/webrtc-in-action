// Session reducer skeleton — Phase 5 scope only.
//
// Implements the top-level `SessionState` FSM from data-model §B.1 for the
// transitions reachable in Phase 5:
//   idle          -> joining       (user submits a valid room ID)
//   joining       -> pending-media (join_accepted; two-phase join rule:
//                                   we do NOT jump to waiting-for-peer;
//                                   that transition only happens in
//                                   Phase 6 after media_ready.)
//   joining       -> idle          (join_rejected; visible error is
//                                   surfaced by the UI)
//   pending-media -> idle          (explicit Leave; no local media to
//                                   clean up in Phase 5)
//
// `peer_presence_changed` updates `remoteParticipant` regardless of
// `SessionState`. `SignalingTransportState` lives in its own slice
// (data-model §B.1.1) and is updated by reducer actions from the
// WebSocket client.
//
// Future phases fill in pending-media -> waiting-for-peer, media-error,
// connecting, connected, failed, leaving; the enum below includes them
// as placeholders so future phases can extend this reducer without
// changing the type surface.

import type {
  JoinAcceptedMessage,
  JoinRejectedMessage,
  PeerPresenceChangedMessage,
  PresenceStatus,
} from "../types/contract";

export type SessionState =
  | "idle"
  | "joining"
  | "pending-media"
  | "waiting-for-peer"
  | "media-error"
  | "connecting"
  | "connected"
  | "failed"
  | "leaving";

export type SignalingTransportState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

export interface RemoteParticipant {
  peerId: string;
  admissionOrder: 1 | 2;
  presence: PresenceStatus;
}

export interface SessionSlice {
  session: SessionState;
  transport: SignalingTransportState;
  roomId: string | null;
  selfPeerId: string | null;
  admissionOrder: 1 | 2 | null;
  remoteParticipant: RemoteParticipant | null;
  joinError: { result: string; message: string } | null;
}

export const initialSessionSlice: SessionSlice = {
  session: "idle",
  transport: "disconnected",
  roomId: null,
  selfPeerId: null,
  admissionOrder: null,
  remoteParticipant: null,
  joinError: null,
};

export type SessionAction =
  | { type: "JOIN_REQUESTED"; roomId: string }
  | { type: "JOIN_ACCEPTED"; message: JoinAcceptedMessage }
  | { type: "JOIN_REJECTED"; message: JoinRejectedMessage }
  | { type: "PEER_PRESENCE_CHANGED"; message: PeerPresenceChangedMessage }
  | { type: "LEAVE_REQUESTED" }
  | { type: "TRANSPORT_CHANGED"; transport: SignalingTransportState };

export class IllegalSessionTransitionError extends Error {
  constructor(from: SessionState, action: SessionAction["type"]) {
    super(
      `illegal session transition: state="${from}" cannot handle action "${action}"`,
    );
    this.name = "IllegalSessionTransitionError";
  }
}

export function sessionReducer(
  state: SessionSlice,
  action: SessionAction,
): SessionSlice {
  switch (action.type) {
    case "TRANSPORT_CHANGED":
      if (action.transport === state.transport) return state;
      return { ...state, transport: action.transport };

    case "PEER_PRESENCE_CHANGED": {
      const { subjectPeerId, admissionOrder, presence } =
        action.message.payload;
      if (subjectPeerId === state.selfPeerId) {
        // self-events are informational; UI updates already occurred
        // via the action that drove the transition.
        return state;
      }
      if (presence === "left" || presence === "released") {
        return { ...state, remoteParticipant: null };
      }
      return {
        ...state,
        remoteParticipant: {
          peerId: subjectPeerId,
          admissionOrder,
          presence,
        },
      };
    }

    case "JOIN_REQUESTED":
      if (state.session !== "idle") {
        throw new IllegalSessionTransitionError(state.session, action.type);
      }
      return {
        ...state,
        session: "joining",
        roomId: action.roomId,
        selfPeerId: null,
        admissionOrder: null,
        remoteParticipant: null,
        joinError: null,
      };

    case "JOIN_ACCEPTED": {
      if (state.session !== "joining") {
        throw new IllegalSessionTransitionError(state.session, action.type);
      }
      const { peerId, admissionOrder, remotePeer } = action.message.payload;
      return {
        ...state,
        session: "pending-media",
        selfPeerId: peerId,
        admissionOrder,
        remoteParticipant: remotePeer
          ? {
              peerId: remotePeer.peerId,
              // We don't know the remote's admission order from this
              // payload shape, so pick the opposite of ours — the room
              // only ever has two slots and admissionOrder is 1 or 2.
              admissionOrder: admissionOrder === 1 ? 2 : 1,
              presence:
                remotePeer.mediaReadiness === "ready"
                  ? "ready"
                  : "pending-media",
            }
          : null,
        joinError: null,
      };
    }

    case "JOIN_REJECTED":
      if (state.session !== "joining") {
        throw new IllegalSessionTransitionError(state.session, action.type);
      }
      return {
        ...initialSessionSlice,
        transport: state.transport,
        joinError: {
          result: action.message.payload.result,
          message: action.message.payload.message,
        },
      };

    case "LEAVE_REQUESTED":
      // "User abandons current attempt back to idle." Phase 5 reaches
      // this from three places:
      //   - JoinForm's Leave button from pending-media.
      //   - Idle already (no-op).
      //   - JoinForm's connect/send error path from joining (local
      //     transport failure; the reducer still thinks we're joining
      //     because no server message ever arrived).
      // Any later state (waiting-for-peer / connecting / connected /
      // etc.) belongs to future phases and will need its own cleanup
      // path, so we still throw for those.
      if (
        state.session !== "idle" &&
        state.session !== "joining" &&
        state.session !== "pending-media"
      ) {
        throw new IllegalSessionTransitionError(state.session, action.type);
      }
      return {
        ...initialSessionSlice,
        transport: state.transport,
      };

    default: {
      const exhaustive: never = action;
      throw new Error(`unhandled session action: ${JSON.stringify(exhaustive)}`);
    }
  }
}
