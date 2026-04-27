// SignalingProvider — creates the WebSocket client + dispatcher once,
// wires transport-state changes and inbound messages to the reducer,
// and exposes both through React context.
//
// Important: creating the provider does NOT open a WebSocket. The WS is
// opened the first time a consumer calls `client.connect(url)` (the
// JoinForm does this on Join click, per the Phase 5 contract that
// "App should NOT start WS activity on render").

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { useDispatch } from "../state";
import { makeEventLogEntry } from "../state/event-log";
import { createSignalingClient, type SignalingClient } from "./client";
import { createSignalingDispatcher } from "./dispatcher";

interface SignalingContextValue {
  client: SignalingClient;
  handleInbound: (raw: string) => void;
}

const SignalingContext = createContext<SignalingContextValue | null>(null);

export function SignalingProvider({
  children,
  client: externalClient,
}: {
  children: ReactNode;
  client?: SignalingClient;
}) {
  const dispatch = useDispatch();
  // Cache the client + dispatcher in a ref so hot-reloading doesn't
  // rebuild them. `useMemo` alone would be fine too, but a ref also
  // keeps the reference stable across StrictMode's double-invocation.
  const ref = useRef<SignalingContextValue | null>(null);
  if (ref.current === null) {
    const client = externalClient ?? createSignalingClient();
    const handleInbound = createSignalingDispatcher({ dispatch, client });
    ref.current = { client, handleInbound };
  }
  const value = ref.current;

  useEffect(() => {
    const unsubMsg = value.client.onMessage((raw) => value.handleInbound(raw));
    const unsubTransport = value.client.onTransportChange((transport) => {
      dispatch({ type: "TRANSPORT_CHANGED", transport });
      dispatch({
        type: "EVENT_LOG_APPEND",
        entry: makeEventLogEntry({
          type: "transport_changed",
          direction: "system",
          summary: `signaling transport → ${transport}`,
          transport: "signaling",
        }),
      });
    });
    return () => {
      unsubMsg();
      unsubTransport();
    };
  }, [dispatch, value]);

  const ctx = useMemo(() => value, [value]);
  return (
    <SignalingContext.Provider value={ctx}>
      {children}
    </SignalingContext.Provider>
  );
}

export function useSignalingClient(): SignalingClient {
  const ctx = useContext(SignalingContext);
  if (!ctx) {
    throw new Error(
      "useSignalingClient must be used inside <SignalingProvider>",
    );
  }
  return ctx.client;
}
