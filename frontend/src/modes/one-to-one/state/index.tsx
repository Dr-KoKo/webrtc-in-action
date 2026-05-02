// React bindings for the 1:1 Zustand store (Phase B1 of the frontend
// rings refactor). The store itself lives in `./store.ts`; this file
// is the thin React surface: <StoreProvider> seeds an instance per
// mount, the typed `useStore` selector hook, plus the
// `useRootState` / `useDispatch` shims that keep existing components
// working until subsequent phases migrate them to selector-based
// reads.

import {
  createContext,
  useContext,
  useState,
  type ReactNode,
} from "react";
import { useStoreWithEqualityFn } from "zustand/traditional";
import {
  createOneToOneStore,
  initialRootState,
  type OneToOneStore,
  type OneToOneStoreState,
  type RootState,
} from "./store";
import type { ChatAction } from "./chat";
import type { DataChannelAction } from "./data-channel";
import type { EventLogAction } from "./event-log";
import type { MediaAction } from "./media";
import type { PeerConnectionAction } from "./peer-connection";
import type { SessionAction } from "./session";

export type { RootState };
export { initialRootState };

export type RootAction =
  | SessionAction
  | EventLogAction
  | PeerConnectionAction
  | DataChannelAction
  | ChatAction
  | MediaAction;

const StoreContext = createContext<OneToOneStore | null>(null);

export function StoreProvider({
  children,
  initialState = initialRootState,
}: {
  children: ReactNode;
  initialState?: RootState;
}) {
  const [store] = useState(() => createOneToOneStore(initialState));
  return (
    <StoreContext.Provider value={store}>{children}</StoreContext.Provider>
  );
}

function useStoreApi(): OneToOneStore {
  const store = useContext(StoreContext);
  if (!store) {
    throw new Error("useStore must be used inside <StoreProvider>");
  }
  return store;
}

export function useStore<T>(
  selector: (state: OneToOneStoreState) => T,
  equalityFn?: (a: T, b: T) => boolean,
): T {
  const store = useStoreApi();
  return useStoreWithEqualityFn(store, selector, equalityFn);
}

const rootStateSelector = (s: OneToOneStoreState): RootState => ({
  session: s.session,
  eventLog: s.eventLog,
  peerConnection: s.peerConnection,
  dataChannel: s.dataChannel,
  chat: s.chat,
  media: s.media,
});

function rootStateEqual(a: RootState, b: RootState): boolean {
  return (
    a.session === b.session &&
    a.eventLog === b.eventLog &&
    a.peerConnection === b.peerConnection &&
    a.dataChannel === b.dataChannel &&
    a.chat === b.chat &&
    a.media === b.media
  );
}

export function useRootState(): RootState {
  return useStore(rootStateSelector, rootStateEqual);
}

// Dispatch shim — maps the legacy `RootAction` discriminated union
// onto the new method API on the store. Lets components that still
// call `useDispatch()(action)` keep working through B1; phases C1-E1
// migrate the callsites to direct `useStore.getState().method()` calls.
export type DispatchFn = (action: RootAction) => void;

function applyAction(store: OneToOneStore, action: RootAction): void {
  const s = store.getState();
  switch (action.type) {
    case "JOIN_REQUESTED":
      s.requestJoin(action.roomId);
      return;
    case "JOIN_ACCEPTED":
      s.acceptJoin(action.message);
      return;
    case "JOIN_REJECTED":
      s.rejectJoin(action.message);
      return;
    case "PEER_PRESENCE_CHANGED":
      s.applyPeerPresenceChange(action.message);
      return;
    case "MEDIA_READY_SENT":
      s.markMediaReadySent();
      return;
    case "PARTICIPANT_RELEASED":
      s.applyParticipantReleased(action.message);
      return;
    case "READY_FOR_OFFER":
      s.markReadyForOffer();
      return;
    case "CONNECTION_ESTABLISHED":
      s.markConnectionEstablished();
      return;
    case "RETRY_REQUESTED":
      s.requestRetry();
      return;
    case "LEAVE_REQUESTED":
      s.requestLeave();
      return;
    case "PEER_LEFT":
      s.applyPeerLeft();
      return;
    case "CONNECTION_FAILED":
      s.markConnectionFailed();
      return;
    case "TRANSPORT_CHANGED":
      s.setTransport(action.transport);
      return;
    case "EVENT_LOG_APPEND":
      s.appendEvent(action.entry);
      return;
    case "PEER_CONNECTION_CREATED":
      s.noteConnectionCreated(action.snapshot);
      return;
    case "PEER_CONNECTION_STATE_CHANGED":
      s.notePeerConnectionStateChanged(action.snapshot);
      return;
    case "PEER_CONNECTION_CLOSED":
      s.notePeerConnectionClosed();
      return;
    case "DATA_CHANNEL_STATE_CHANGED":
      s.setDataChannelState(action.state);
      return;
    case "DATA_CHANNEL_RESET":
      s.resetDataChannel();
      return;
    case "CHAT_MESSAGE_APPENDED":
      s.appendChatMessage(action.message);
      return;
    case "CHAT_CLEARED":
      s.clearChat();
      return;
    case "LOCAL_MEDIA_STATE_SET":
      s.setLocalMediaState(action.triplet);
      return;
    case "REMOTE_MEDIA_STATE_RECEIVED":
      s.receiveRemoteMediaState(action.triplet);
      return;
    case "REMOTE_MEDIA_STATE_CLEARED":
      s.clearRemoteMediaState();
      return;
    case "MEDIA_STATE_RESET":
      s.resetMediaState();
      return;
    default: {
      const _exhaustive: never = action;
      void _exhaustive;
    }
  }
}

export function useDispatch(): DispatchFn {
  const store = useStoreApi();
  return (action) => applyAction(store, action);
}

export function useStoreApiRaw(): OneToOneStore {
  return useStoreApi();
}

// Test-friendly exports — let dispatcher contract tests drive the
// store from the same `RootAction` union components use, without
// mounting a React tree.
export { applyAction as applyRootAction };
export { createOneToOneStore } from "./store";

// Compat shim: a stateless `(state, action) => state` rooted in the
// store's method semantics. Used only by reducer-style harnesses in
// `tests/contract/dispatcher.spec.ts`. The production runtime never
// builds RootState by reduction — it lives inside the Zustand store.
export function rootReducer(state: RootState, action: RootAction): RootState {
  const tmp = createOneToOneStore(state);
  applyAction(tmp, action);
  return rootStateSelector(tmp.getState());
}
