// Root reducer + React context.
//
// `RootState` composes the shipped slices: `session` (Phase 5/6),
// `eventLog` (Phase 5), and `peerConnection` (Phase 7 — mirrors the
// four `RTCPeerConnection` getters from data-model §B.4).

import {
  createContext,
  useContext,
  useMemo,
  useReducer,
  type Dispatch,
  type ReactNode,
} from "react";
import {
  eventLogReducer,
  initialEventLogSlice,
  type EventLogAction,
  type EventLogSlice,
} from "./event-log";
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
}

export type RootAction = SessionAction | EventLogAction | PeerConnectionAction;

export const initialRootState: RootState = {
  session: initialSessionSlice,
  eventLog: initialEventLogSlice,
  peerConnection: initialPeerConnectionSlice,
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
