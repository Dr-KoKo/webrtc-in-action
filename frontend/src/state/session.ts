// Session reducer — Phase 5 + Phase 6 scope.
//
// Implements the top-level `SessionState` FSM from data-model §B.1 for
// the transitions reachable in Phases 5 and 6:
//   idle          -> joining          (user submits a valid room ID)
//   joining       -> pending-media    (join_accepted; two-phase join
//                                      rule: admission first, media
//                                      second. We do NOT jump to
//                                      waiting-for-peer here.)
//   joining       -> idle             (join_rejected; visible error is
//                                      surfaced by the UI)
//   pending-media -> waiting-for-peer (local media_ready sent — the
//                                      client is now media-ready.
//                                      Pairing for offer still waits
//                                      for ready_for_offer from the
//                                      server in Phase 7.)
//   pending-media -> media-error      (server participant_released with
//                                      reason=media_failed — our slot
//                                      was released because we sent
//                                      media_failed or timed out.)
//   media-error   -> joining          (user clicks Retry; re-enters the
//                                      join flow on the existing WS)
//   *             -> idle             (explicit Leave — from idle,
//                                      joining, pending-media, and
//                                      media-error. Local track
//                                      cleanup is driven by the
//                                      LocalMediaProvider in response
//                                      to the LEAVE_REQUESTED action.)
//
// `peer_presence_changed` updates `remoteParticipant` regardless of
// `SessionState`. `SignalingTransportState` lives in its own slice
// (data-model §B.1.1) and is updated by reducer actions from the
// WebSocket client.
//
// Future phases fill in connecting, connected, failed, leaving; the
// enum below includes them as placeholders so future phases can extend
// this reducer without changing the type surface.

import type {
  JoinAcceptedMessage,
  JoinRejectedMessage,
  ParticipantReleasedMessage,
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
  | { type: "MEDIA_READY_SENT" }
  | {
      type: "PARTICIPANT_RELEASED";
      message: ParticipantReleasedMessage;
    }
  | { type: "READY_FOR_OFFER" }
  | { type: "CONNECTION_ESTABLISHED" }
  | { type: "RETRY_REQUESTED" }
  | { type: "LEAVE_REQUESTED" }
  | { type: "PEER_LEFT" }
  | { type: "CONNECTION_FAILED" }
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

    case "MEDIA_READY_SENT":
      // Local `media_ready` envelope has been handed to the WS. This
      // is the two-phase-join completion on the client side; the
      // session moves to `waiting-for-peer` even though pairing for
      // `ready_for_offer` is still the server's decision (Phase 7).
      if (state.session !== "pending-media") {
        throw new IllegalSessionTransitionError(state.session, action.type);
      }
      return { ...state, session: "waiting-for-peer" };

    case "READY_FOR_OFFER":
      // Server sent `ready_for_offer` — we're paired, role assigned.
      // Transition is waiting-for-peer → connecting (data-model §B.1).
      // The PeerConnectionProvider pre-filters on session state before
      // dispatching this action; if somehow dispatched from a
      // non-legal state (late duplicate, server bug, race), silently
      // no-op rather than throw. The provider logs the duplicate as
      // `unexpected_ready_for_offer` at the event-log layer per
      // contract §3.7.
      if (state.session !== "waiting-for-peer") {
        return state;
      }
      return { ...state, session: "connecting" };

    case "CONNECTION_ESTABLISHED":
      // Phase 8: RTCPeerConnection reached connectionState === "connected".
      // Only promote from `connecting`; the action is a no-op in any
      // other state so a spurious event during renegotiation or
      // cleanup is harmless (future cleanup phases will layer on
      // explicit transitions).
      if (state.session !== "connecting") {
        return state;
      }
      return { ...state, session: "connected" };

    case "PARTICIPANT_RELEASED": {
      // Server released our slot. Phase 6 only wires the media_failed
      // branch: `pending-media` → `media-error`. The `disconnect`
      // branch is logged by the dispatcher but does not drive a
      // client-side transition here — the client typically observes
      // the WS close directly for that case (see data-model §B.1).
      if (action.message.payload.reason !== "media_failed") {
        return state;
      }
      if (state.session !== "pending-media") {
        throw new IllegalSessionTransitionError(state.session, action.type);
      }
      return { ...state, session: "media-error" };
    }

    case "RETRY_REQUESTED":
      // User clicked Retry in `media-error`. Return to `joining` so the
      // JoinForm can re-send `join_room` on the existing WS (data-model
      // §B.1 "Retry re-enters joining"; contract §3.3 "same WS MAY
      // send a new join_room afterward"). roomId is preserved; the
      // peer-identity fields are cleared because re-admission will
      // issue a fresh peerId.
      if (state.session !== "media-error") {
        throw new IllegalSessionTransitionError(state.session, action.type);
      }
      return {
        ...state,
        session: "joining",
        selfPeerId: null,
        admissionOrder: null,
        remoteParticipant: null,
        joinError: null,
      };

    case "LEAVE_REQUESTED":
      // Phase 12 (§C.5 Path A): Leave is accepted from every non-idle
      // state the FSM can reach — idle (no-op), joining, pending-media,
      // media-error, waiting-for-peer, connecting, connected, failed
      // (user clicked Leave in the failure panel), and leaving (Leave
      // is idempotent during cleanup). Returning to `idle` is the
      // caller's responsibility for the surrounding teardown (stop
      // local tracks, close DC/PC, close WS — see
      // `frontend/src/webrtc/cleanup.ts`).
      return {
        ...initialSessionSlice,
        transport: state.transport,
      };

    case "PEER_LEFT":
      // Phase 12 (§C.5 Path B): remote peer departed mid-call. We stay
      // in the room, keep local tracks live, and wait for a new peer.
      // Legal only from `connecting | connected`. Any other state is a
      // no-op (pending-media / waiting-for-peer never had a PC;
      // dispatcher guards that at the boundary — see
      // `frontend/src/webrtc/cleanup.ts` invariant).
      if (state.session !== "connecting" && state.session !== "connected") {
        return state;
      }
      return {
        ...state,
        session: "waiting-for-peer",
        remoteParticipant: null,
      };

    case "CONNECTION_FAILED":
      // Phase 12 (§C.5 Path C + §B.1.1 signaling-disconnect branch):
      // terminal failure from either ICE / fatal PC state or from a
      // signaling-transport drop while no stable P2P exists yet
      // (`joining | pending-media | waiting-for-peer | connecting`).
      // `connected` is ALSO a legal entry because ICE failure during a
      // live call must go to terminal `failed` (§B.1 transition
      // `connected → failed` on ICE). Signaling disconnect during
      // `connected` is NOT a failure — it dispatches TRANSPORT_CHANGED
      // alone, without CONNECTION_FAILED.
      if (
        state.session !== "joining" &&
        state.session !== "pending-media" &&
        state.session !== "waiting-for-peer" &&
        state.session !== "connecting" &&
        state.session !== "connected"
      ) {
        return state;
      }
      return { ...state, session: "failed" };

    default: {
      const exhaustive: never = action;
      throw new Error(`unhandled session action: ${JSON.stringify(exhaustive)}`);
    }
  }
}
