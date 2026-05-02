// PeerConnectionProvider — D1: thin React wrapper that wires the
// per-mount Ctx (refs, store, client, log) to the verb-files in
// `webrtc/{negotiation,trickle,datachannel-attach,chat}.ts`. The verb
// bodies that used to live as nested `function handle*` definitions
// here are gone; this file owns lifecycle (refs, mount/unmount, the
// inbound dispatcher, teardown) and nothing else.
//
// E1 will collapse this provider entirely into `mode/runtime.ts` +
// `mode/dispatcher.ts`; until then, components keep importing
// `usePeerConnection()` from here.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useDispatch, useRootState, useStoreApiRaw } from "../state";
import { useFrameSubscription, useSignalingClient } from "../signaling/provider";
import { signalingMessageSchema } from "../protocol/schema";
import { useLocalMedia } from "./local-media-provider";
import {
  type CreatePeerConnectionOptions,
  type PeerConnectionHandle,
} from "./peer-connection";
import { type IceBuffer } from "./ice-buffer";
import { type DataChannelWrapper } from "./data-channel";
import {
  initialInspectorSnapshot,
  type LearningInspectorSnapshot,
} from "./learning-inspector";
import { makeLog } from "./log";
import type { CleanupSource, OneToOneCtx, OneToOneRefs } from "./ctx";
import {
  handleAnswer,
  handleOffer,
  handleReadyForOffer,
} from "./negotiation";
import { handleIceCandidate } from "./trickle";
import { attachChatDataChannel } from "./datachannel-attach";
import { sendChatMessage, type ChatSendOutcome } from "./chat";

export type { CleanupSource } from "./ctx";
export type { ChatSendOutcome, ChatSendError } from "./chat";

export interface PeerConnectionContextValue {
  getHandle(): PeerConnectionHandle | null;
  getRemoteStream(): MediaStream | null;
  remoteStreamVersion: number;
  hasRemoteStream: boolean;
  inspector: LearningInspectorSnapshot;
  sendChatMessage(text: string): ChatSendOutcome;
  teardownPeerConnection(source: CleanupSource): void;
}

export const PeerConnectionContext =
  createContext<PeerConnectionContextValue | null>(null);

export interface PeerConnectionProviderProps {
  children: ReactNode;
  peerConnectionFactory?: CreatePeerConnectionOptions["factory"];
}

export function PeerConnectionProvider({
  children,
  peerConnectionFactory,
}: PeerConnectionProviderProps) {
  const dispatch = useDispatch();
  const state = useRootState();
  const client = useSignalingClient();
  const localMedia = useLocalMedia();
  const store = useStoreApiRaw();

  // Per-pairing refs. Browser objects + transient cache live here
  // because they are not React-state-safe.
  const handleRef = useRef<PeerConnectionHandle | null>(null);
  const iceBufferRef = useRef<IceBuffer | null>(null);
  const chatChannelRef = useRef<DataChannelWrapper | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const activeRoomIdRef = useRef<string | null>(null);
  const roleRef = useRef<"offerer" | "answerer" | null>(null);

  const [remoteStreamVersion, setRemoteStreamVersion] = useState(0);
  const [inspector, setInspector] = useState<LearningInspectorSnapshot>(
    initialInspectorSnapshot,
  );

  // Mirrors of mutable session / local-media getters. Verbs read these
  // through the Ctx via `refs.session.current` / `refs.getLocalStream
  // .current()` so async WS handlers see fresh values.
  const sessionRef = useRef(state.session);
  sessionRef.current = state.session;
  const getLocalStreamRef = useRef(localMedia.getStream);
  getLocalStreamRef.current = localMedia.getStream;

  const refs: OneToOneRefs = {
    handle: handleRef,
    iceBuffer: iceBufferRef,
    chatChannel: chatChannelRef,
    remoteStream: remoteStreamRef,
    activeRoomId: activeRoomIdRef,
    role: roleRef,
    session: sessionRef,
    getLocalStream: getLocalStreamRef,
  };

  // Stable log — closes over the latest dispatch via the React closure
  // each render; the helper itself is identity-stable for the
  // useEffect dep array via useRef.
  const logRef = useRef(
    makeLog((entry) => dispatch({ type: "EVENT_LOG_APPEND", entry })),
  );
  // Refresh the log's dispatch closure on every render so it always
  // writes through the current dispatch fn (cheap; no re-allocation).
  logRef.current = makeLog((entry) => dispatch({ type: "EVENT_LOG_APPEND", entry }));

  const bumpRemoteVersion = useCallback(() => {
    setRemoteStreamVersion((v) => v + 1);
  }, []);

  // §C.5 shared teardown — invoked from four places:
  //   1. unmount effect below (HMR / StrictMode / route change).
  //   2. leaveSession() in `webrtc/cleanup.ts` (Path A).
  //   3. remotePeerLeft() in `webrtc/cleanup.ts` (Path B).
  //   4. negotiation.ts onConnectionStateChange="failed" (Path C).
  // Idempotent: every ref / close() is guarded against double-invoke.
  const teardownPeerConnection = useCallback(
    (_source: CleanupSource): void => {
      chatChannelRef.current?.close();
      chatChannelRef.current = null;
      handleRef.current?.close();
      handleRef.current = null;
      iceBufferRef.current?.close();
      iceBufferRef.current = null;
      activeRoomIdRef.current = null;
      roleRef.current = null;
      const rs = remoteStreamRef.current;
      if (rs) {
        for (const t of rs.getTracks()) rs.removeTrack(t);
      }
      remoteStreamRef.current = null;
      setRemoteStreamVersion((v) => v + 1);
      setInspector(initialInspectorSnapshot);
      store.getState().notePeerConnectionClosed();
      store.getState().resetDataChannel();
    },
    [store],
  );

  // The Ctx that the verb files consume. Recomputed each render but
  // every field is identity-stable (refs/setters/store), so verb
  // closures captured by the message handler stay coherent.
  const ctx: OneToOneCtx = useMemo(
    () => ({
      store,
      dispatch,
      client,
      log: logRef.current,
      refs,
      bumpRemoteVersion,
      setInspector,
      ...(peerConnectionFactory ? { peerConnectionFactory } : {}),
      attachChatDataChannel: (channel, origin) =>
        attachChatDataChannel(ctxRef.current, channel, origin),
      teardownPeerConnection,
    }),
    // refs and dispatch are stable; store/client/localMedia identity
    // changes only when StoreProvider/SignalingProvider remount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, dispatch, client, bumpRemoteVersion, teardownPeerConnection],
  );
  // Self-reference so attachChatDataChannel inside ctx can reach the
  // current ctx without a temporal-dead-zone. The ref always points at
  // the latest ctx value.
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  // Phase E1: route every raw frame through the central
  // SignalingProvider subscription. Parse here is intentionally
  // independent of the central dispatcher's parse — error logging on
  // malformed envelopes belongs to the central dispatcher (one source
  // of truth); this side only acts on the four PC-relevant types.
  useFrameSubscription((raw) => {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return;
    }
    const parsed = signalingMessageSchema.safeParse(json);
    if (!parsed.success) return;
    const msg = parsed.data;
    switch (msg.type) {
      case "ready_for_offer":
        void handleReadyForOffer(ctxRef.current, msg);
        return;
      case "offer":
        void handleOffer(ctxRef.current, msg);
        return;
      case "answer":
        void handleAnswer(ctxRef.current, msg);
        return;
      case "ice_candidate":
        void handleIceCandidate(ctxRef.current, msg);
        return;
      default:
        return;
    }
  }, []);

  // Unmount cleanup — final safety net. Mid-lifetime teardown paths
  // call `teardownPeerConnection` directly via the context.
  useEffect(() => {
    return () => {
      chatChannelRef.current?.close();
      chatChannelRef.current = null;
      handleRef.current?.close();
      handleRef.current = null;
      iceBufferRef.current?.close();
      iceBufferRef.current = null;
      activeRoomIdRef.current = null;
      roleRef.current = null;
      const rs = remoteStreamRef.current;
      if (rs) {
        for (const t of rs.getTracks()) rs.removeTrack(t);
      }
      remoteStreamRef.current = null;
    };
  }, []);

  const getRemoteStream = useCallback(() => remoteStreamRef.current, []);

  const value: PeerConnectionContextValue = {
    getHandle: () => handleRef.current,
    getRemoteStream,
    remoteStreamVersion,
    hasRemoteStream:
      remoteStreamVersion > 0 && remoteStreamRef.current !== null,
    inspector,
    sendChatMessage: (text) => sendChatMessage(ctxRef.current, text),
    teardownPeerConnection,
  };

  return (
    <PeerConnectionContext.Provider value={value}>
      {children}
    </PeerConnectionContext.Provider>
  );
}

export function usePeerConnection(): PeerConnectionContextValue {
  const ctx = useContext(PeerConnectionContext);
  if (!ctx) {
    throw new Error(
      "usePeerConnection must be used inside <PeerConnectionProvider>",
    );
  }
  return ctx;
}
