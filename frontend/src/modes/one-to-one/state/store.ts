// Zustand store for the 1:1 mode (Phase B1 of the frontend rings
// refactor — `specs/frontend-architecture.md` §3.4).
//
// Replaces the previous `useReducer` + Context + 5-way `is*Action`
// discriminator. The per-slice reducer functions (chat / data-channel /
// event-log / media / peer-connection / session) stay as the
// authoritative state-transition logic — the store methods are thin
// wrappers that pipe a typed payload through the matching reducer.
// Phase D1 / E1 verb files will call these methods directly; the
// `dispatch()` shim in `./index.tsx` keeps existing component callers
// working until then.

import { createStore, type StoreApi } from "zustand/vanilla";
import {
  chatReducer,
  initialChatSlice,
  type ChatMessage,
  type ChatSlice,
} from "./chat";
import {
  dataChannelReducer,
  initialDataChannelSlice,
  type DataChannelSlice,
} from "./data-channel";
import {
  eventLogReducer,
  initialEventLogSlice,
  type EventLogEntry,
  type EventLogSlice,
} from "./event-log";
import {
  initialMediaSlice,
  mediaReducer,
  type MediaSlice,
  type MediaTriplet,
} from "./media";
import {
  initialPeerConnectionSlice,
  peerConnectionReducer,
  type PeerConnectionSlice,
  type PeerConnectionSnapshot,
} from "./peer-connection";
import {
  initialSessionSlice,
  sessionReducer,
  type SessionSlice,
  type SignalingTransportState,
} from "./session";
import type { DataChannelStateValue } from "./data-channel";
import type {
  JoinAcceptedMessage,
  JoinRejectedMessage,
  ParticipantReleasedMessage,
  PeerPresenceChangedMessage,
} from "../types/contract";

export interface RootState {
  session: SessionSlice;
  eventLog: EventLogSlice;
  peerConnection: PeerConnectionSlice;
  dataChannel: DataChannelSlice;
  chat: ChatSlice;
  media: MediaSlice;
}

export const initialRootState: RootState = {
  session: initialSessionSlice,
  eventLog: initialEventLogSlice,
  peerConnection: initialPeerConnectionSlice,
  dataChannel: initialDataChannelSlice,
  chat: initialChatSlice,
  media: initialMediaSlice,
};

// Verb-shaped methods. One per current XxxAction case; bodies pipe
// the typed payload through the matching slice reducer so the FSM
// guards (e.g. `IllegalSessionTransitionError`) stay verbatim.
export interface RootMethods {
  // session slice
  requestJoin(roomId: string): void;
  acceptJoin(message: JoinAcceptedMessage): void;
  rejectJoin(message: JoinRejectedMessage): void;
  applyPeerPresenceChange(message: PeerPresenceChangedMessage): void;
  markMediaReadySent(): void;
  applyParticipantReleased(message: ParticipantReleasedMessage): void;
  markReadyForOffer(): void;
  markConnectionEstablished(): void;
  requestRetry(): void;
  requestLeave(): void;
  applyPeerLeft(): void;
  markConnectionFailed(): void;
  setTransport(transport: SignalingTransportState): void;

  // event-log slice
  appendEvent(entry: EventLogEntry): void;

  // peer-connection slice
  noteConnectionCreated(snapshot: PeerConnectionSnapshot): void;
  notePeerConnectionStateChanged(snapshot: Partial<PeerConnectionSnapshot>): void;
  notePeerConnectionClosed(): void;

  // data-channel slice
  setDataChannelState(state: DataChannelStateValue): void;
  resetDataChannel(): void;

  // chat slice
  appendChatMessage(message: ChatMessage): void;
  clearChat(): void;

  // media slice
  setLocalMediaState(triplet: MediaTriplet): void;
  receiveRemoteMediaState(triplet: MediaTriplet): void;
  clearRemoteMediaState(): void;
  resetMediaState(): void;
}

export type OneToOneStoreState = RootState & RootMethods;
export type OneToOneStore = StoreApi<OneToOneStoreState>;

export function createOneToOneStore(
  initialState: RootState = initialRootState,
): OneToOneStore {
  return createStore<OneToOneStoreState>((set) => ({
    ...initialState,

    // session
    requestJoin: (roomId) =>
      set((s) => ({
        session: sessionReducer(s.session, { type: "JOIN_REQUESTED", roomId }),
      })),
    acceptJoin: (message) =>
      set((s) => ({
        session: sessionReducer(s.session, { type: "JOIN_ACCEPTED", message }),
      })),
    rejectJoin: (message) =>
      set((s) => ({
        session: sessionReducer(s.session, { type: "JOIN_REJECTED", message }),
      })),
    applyPeerPresenceChange: (message) =>
      set((s) => ({
        session: sessionReducer(s.session, {
          type: "PEER_PRESENCE_CHANGED",
          message,
        }),
      })),
    markMediaReadySent: () =>
      set((s) => ({
        session: sessionReducer(s.session, { type: "MEDIA_READY_SENT" }),
      })),
    applyParticipantReleased: (message) =>
      set((s) => ({
        session: sessionReducer(s.session, {
          type: "PARTICIPANT_RELEASED",
          message,
        }),
      })),
    markReadyForOffer: () =>
      set((s) => ({
        session: sessionReducer(s.session, { type: "READY_FOR_OFFER" }),
      })),
    markConnectionEstablished: () =>
      set((s) => ({
        session: sessionReducer(s.session, { type: "CONNECTION_ESTABLISHED" }),
      })),
    requestRetry: () =>
      set((s) => ({
        session: sessionReducer(s.session, { type: "RETRY_REQUESTED" }),
      })),
    requestLeave: () =>
      set((s) => ({
        session: sessionReducer(s.session, { type: "LEAVE_REQUESTED" }),
      })),
    applyPeerLeft: () =>
      set((s) => ({
        session: sessionReducer(s.session, { type: "PEER_LEFT" }),
      })),
    markConnectionFailed: () =>
      set((s) => ({
        session: sessionReducer(s.session, { type: "CONNECTION_FAILED" }),
      })),
    setTransport: (transport) =>
      set((s) => ({
        session: sessionReducer(s.session, {
          type: "TRANSPORT_CHANGED",
          transport,
        }),
      })),

    // event-log
    appendEvent: (entry) =>
      set((s) => ({
        eventLog: eventLogReducer(s.eventLog, {
          type: "EVENT_LOG_APPEND",
          entry,
        }),
      })),

    // peer-connection
    noteConnectionCreated: (snapshot) =>
      set((s) => ({
        peerConnection: peerConnectionReducer(s.peerConnection, {
          type: "PEER_CONNECTION_CREATED",
          snapshot,
        }),
      })),
    notePeerConnectionStateChanged: (snapshot) =>
      set((s) => ({
        peerConnection: peerConnectionReducer(s.peerConnection, {
          type: "PEER_CONNECTION_STATE_CHANGED",
          snapshot,
        }),
      })),
    notePeerConnectionClosed: () =>
      set((s) => ({
        peerConnection: peerConnectionReducer(s.peerConnection, {
          type: "PEER_CONNECTION_CLOSED",
        }),
      })),

    // data-channel
    setDataChannelState: (state) =>
      set((s) => ({
        dataChannel: dataChannelReducer(s.dataChannel, {
          type: "DATA_CHANNEL_STATE_CHANGED",
          state,
        }),
      })),
    resetDataChannel: () =>
      set((s) => ({
        dataChannel: dataChannelReducer(s.dataChannel, {
          type: "DATA_CHANNEL_RESET",
        }),
      })),

    // chat
    appendChatMessage: (message) =>
      set((s) => ({
        chat: chatReducer(s.chat, { type: "CHAT_MESSAGE_APPENDED", message }),
      })),
    clearChat: () =>
      set((s) => ({
        chat: chatReducer(s.chat, { type: "CHAT_CLEARED" }),
      })),

    // media
    setLocalMediaState: (triplet) =>
      set((s) => ({
        media: mediaReducer(s.media, { type: "LOCAL_MEDIA_STATE_SET", triplet }),
      })),
    receiveRemoteMediaState: (triplet) =>
      set((s) => ({
        media: mediaReducer(s.media, {
          type: "REMOTE_MEDIA_STATE_RECEIVED",
          triplet,
        }),
      })),
    clearRemoteMediaState: () =>
      set((s) => ({
        media: mediaReducer(s.media, { type: "REMOTE_MEDIA_STATE_CLEARED" }),
      })),
    resetMediaState: () =>
      set((s) => ({
        media: mediaReducer(s.media, { type: "MEDIA_STATE_RESET" }),
      })),
  }));
}
