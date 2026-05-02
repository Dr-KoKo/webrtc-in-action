// SignalingProvider — creates the WebSocket client + dispatcher once,
// wires transport-state changes and inbound messages to the reducer,
// and exposes both through React context.
//
// Phase E1: this is the SOLE owner of `client.onMessage`. Other
// providers that previously called `client.onMessage` themselves
// (PeerConnectionProvider, CleanupProvider) now register frame
// listeners with `useFrameSubscription` — the central onMessage
// handler fans every raw frame out to them. Result: one
// `client.onMessage` subscription per mount instead of three.
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
import { useLog } from "../webrtc/log";
import { createSignalingClient, type SignalingClient } from "./client";
import { createSignalingDispatcher } from "./dispatcher";

export type FrameListener = (raw: string) => void;

interface SignalingContextValue {
  client: SignalingClient;
  handleInbound: FrameListener;
  /**
   * Subscribe to every raw inbound WS frame. Used by `webrtc/`
   * consumers (PC + cleanup) so they no longer subscribe to
   * `client.onMessage` themselves — the central onMessage handler in
   * this provider broadcasts to all subscribers. Returns an
   * unsubscribe fn.
   */
  subscribeToFrames(listener: FrameListener): () => void;
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
  const log = useLog();
  // Cache the client + dispatcher in a ref so hot-reloading doesn't
  // rebuild them. `useMemo` alone would be fine too, but a ref also
  // keeps the reference stable across StrictMode's double-invocation.
  const frameListenersRef = useRef<Set<FrameListener>>(new Set());
  const ref = useRef<SignalingContextValue | null>(null);
  if (ref.current === null) {
    const client = externalClient ?? createSignalingClient();
    const handleInbound = createSignalingDispatcher({ dispatch, client });
    const subscribeToFrames: SignalingContextValue["subscribeToFrames"] = (
      listener,
    ) => {
      frameListenersRef.current.add(listener);
      return () => {
        frameListenersRef.current.delete(listener);
      };
    };
    ref.current = { client, handleInbound, subscribeToFrames };
  }
  const value = ref.current;

  useEffect(() => {
    const unsubMsg = value.client.onMessage((raw) => {
      // Central dispatcher first — owns error logging on parse
      // failure so we never silently drop a frame.
      value.handleInbound(raw);
      // Fan-out to registered subscribers (PC + cleanup verbs).
      // Snapshotting prevents re-entrant subscribe/unsubscribe calls
      // from mutating the iterator mid-loop.
      for (const listener of [...frameListenersRef.current]) {
        listener(raw);
      }
    });
    const unsubTransport = value.client.onTransportChange((transport) => {
      dispatch({ type: "TRANSPORT_CHANGED", transport });
      log.signaling({
        type: "transport_changed",
        direction: "system",
        summary: `signaling transport → ${transport}`,
      });
    });
    return () => {
      unsubMsg();
      unsubTransport();
    };
  }, [dispatch, log, value]);

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

/**
 * Subscribe to every raw inbound frame. Phase E1: replaces direct
 * `client.onMessage` subscriptions outside this file so the structural
 * invariant (one onMessage per mount) holds.
 */
export function useFrameSubscription(
  listener: FrameListener,
  deps: ReadonlyArray<unknown>,
): void {
  const ctx = useContext(SignalingContext);
  if (!ctx) {
    throw new Error(
      "useFrameSubscription must be used inside <SignalingProvider>",
    );
  }
  useEffect(() => {
    return ctx.subscribeToFrames(listener);
    // Caller-provided deps drive resubscription; identity of `ctx`
    // is stable per mount so it stays out of the dep list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
