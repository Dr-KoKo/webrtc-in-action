// Root reducer + React context. Phase 5 scope only.
//
// `RootState` is a thin composition of the two Phase 5 slices
// (`session` + `eventLog`). Future phases (media, peer-connection, chat)
// will add new slices here.

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
  initialSessionSlice,
  sessionReducer,
  type SessionAction,
  type SessionSlice,
} from "./session";

export interface RootState {
  session: SessionSlice;
  eventLog: EventLogSlice;
}

export type RootAction = SessionAction | EventLogAction;

export const initialRootState: RootState = {
  session: initialSessionSlice,
  eventLog: initialEventLogSlice,
};

function isEventLogAction(action: RootAction): action is EventLogAction {
  return action.type === "EVENT_LOG_APPEND";
}

export function rootReducer(state: RootState, action: RootAction): RootState {
  if (isEventLogAction(action)) {
    return {
      ...state,
      eventLog: eventLogReducer(state.eventLog, action),
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
