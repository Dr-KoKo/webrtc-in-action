// Root reducer + React context.
//
// `RootState` composes the shipped slices: `session` (Phase 5/6),
// `eventLog` (Phase 5), `peerConnection` (Phase 7 — mirrors the
// four `RTCPeerConnection` getters from data-model §B.4), plus
// Phase 9's `dataChannel` (B.5 — `absent | connecting | open |
// closing | closed`) and `chat` (B.8 — transcript entries).

import {
  createContext,
  useContext,
  useMemo,
  useReducer,
  type Dispatch,
  type ReactNode,
} from "react";
import {
  chatReducer,
  initialChatSlice,
  type ChatAction,
  type ChatSlice,
} from "./chat";
import {
  dataChannelReducer,
  initialDataChannelSlice,
  type DataChannelAction,
  type DataChannelSlice,
} from "./data-channel";
import {
  eventLogReducer,
  initialEventLogSlice,
  type EventLogAction,
  type EventLogSlice,
} from "./event-log";
import {
  initialMediaSlice,
  mediaReducer,
  type MediaAction,
  type MediaSlice,
} from "./media";
import {
  initialPeerConnectionSlice,
  peerConnectionReducer,
  type PeerConnectionAction,
  type PeerConnectionSlice,
} from "./peer-connection";
import {
  initialSessionSlice,
  sessionReducer,
  type SessionAction,
  type SessionSlice,
} from "./session";

export interface RootState {
  session: SessionSlice;
  eventLog: EventLogSlice;
  peerConnection: PeerConnectionSlice;
  dataChannel: DataChannelSlice;
  chat: ChatSlice;
  media: MediaSlice;
}

export type RootAction =
  | SessionAction
  | EventLogAction
  | PeerConnectionAction
  | DataChannelAction
  | ChatAction
  | MediaAction;

export const initialRootState: RootState = {
  session: initialSessionSlice,
  eventLog: initialEventLogSlice,
  peerConnection: initialPeerConnectionSlice,
  dataChannel: initialDataChannelSlice,
  chat: initialChatSlice,
  media: initialMediaSlice,
};

function isEventLogAction(action: RootAction): action is EventLogAction {
  return action.type === "EVENT_LOG_APPEND";
}

function isPeerConnectionAction(
  action: RootAction,
): action is PeerConnectionAction {
  return (
    action.type === "PEER_CONNECTION_CREATED" ||
    action.type === "PEER_CONNECTION_STATE_CHANGED" ||
    action.type === "PEER_CONNECTION_CLOSED"
  );
}

function isDataChannelAction(
  action: RootAction,
): action is DataChannelAction {
  return (
    action.type === "DATA_CHANNEL_STATE_CHANGED" ||
    action.type === "DATA_CHANNEL_RESET"
  );
}

function isChatAction(action: RootAction): action is ChatAction {
  return (
    action.type === "CHAT_MESSAGE_APPENDED" || action.type === "CHAT_CLEARED"
  );
}

function isMediaAction(action: RootAction): action is MediaAction {
  return (
    action.type === "LOCAL_MEDIA_STATE_SET" ||
    action.type === "REMOTE_MEDIA_STATE_RECEIVED" ||
    action.type === "MEDIA_STATE_RESET"
  );
}

export function rootReducer(state: RootState, action: RootAction): RootState {
  if (isEventLogAction(action)) {
    return {
      ...state,
      eventLog: eventLogReducer(state.eventLog, action),
    };
  }
  if (isPeerConnectionAction(action)) {
    return {
      ...state,
      peerConnection: peerConnectionReducer(state.peerConnection, action),
    };
  }
  if (isDataChannelAction(action)) {
    return {
      ...state,
      dataChannel: dataChannelReducer(state.dataChannel, action),
    };
  }
  if (isChatAction(action)) {
    return {
      ...state,
      chat: chatReducer(state.chat, action),
    };
  }
  if (isMediaAction(action)) {
    return {
      ...state,
      media: mediaReducer(state.media, action),
    };
  }
  return {
    ...state,
    session: sessionReducer(state.session, action),
  };
}

interface StoreContextValue {
  state: RootState;
  dispatch: Dispatch<RootAction>;
}

const StoreContext = createContext<StoreContextValue | null>(null);

export function StoreProvider({
  children,
  initialState = initialRootState,
}: {
  children: ReactNode;
  initialState?: RootState;
}) {
  const [state, dispatch] = useReducer(rootReducer, initialState);
  const value = useMemo(() => ({ state, dispatch }), [state]);
  return (
    <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
  );
}

function useStore(): StoreContextValue {
  const ctx = useContext(StoreContext);
  if (!ctx) {
    throw new Error("useStore must be used inside <StoreProvider>");
  }
  return ctx;
}

export function useRootState(): RootState {
  return useStore().state;
}

export function useDispatch(): Dispatch<RootAction> {
  return useStore().dispatch;
}
