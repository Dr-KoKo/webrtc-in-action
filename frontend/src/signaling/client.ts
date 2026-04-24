// Minimal WebSocket client for the signaling layer (data-model §B.1.1,
// contract §3.16).
//
// Scope (Phase 5 / T036):
// - connect(url), send(message), onMessage(cb), close() — all idempotent.
// - Outbound messages are Zod-validated before JSON.stringify so a
//   malformed local producer is caught in-process (NFR-003 defence-in-
//   depth).
// - A small observer pattern exposes `SignalingTransportState` to the
//   rest of the app (rendered in `StateIndicators`).
// - Ping/Pong is handled by the browser transparently (the spec's
//   §3.16 contract). This client never emits JSON ping/pong messages.
// - No auto-reconnect, no background retry — reconnection is manual
//   per the MVP scope (plan review-pass-4).

import type { SignalingTransportState } from "../state/session";
import { signalingMessageSchema, type SignalingMessage } from "./schema";

type MessageListener = (raw: string) => void;
type TransportListener = (state: SignalingTransportState) => void;

export interface SignalingClient {
  connect(url: string): Promise<void>;
  send(message: SignalingMessage): void;
  onMessage(listener: MessageListener): () => void;
  onTransportChange(listener: TransportListener): () => void;
  getTransportState(): SignalingTransportState;
  close(code?: number, reason?: string): void;
}

export class SignalingClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignalingClientError";
  }
}

type WebSocketLike = {
  readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

type WebSocketFactory = (url: string) => WebSocketLike;

const defaultFactory: WebSocketFactory = (url) => new WebSocket(url);

const OPEN_STATE = 1;

export function createSignalingClient(
  factory: WebSocketFactory = defaultFactory,
): SignalingClient {
  let socket: WebSocketLike | null = null;
  let transport: SignalingTransportState = "disconnected";
  let closed = false;
  const messageListeners = new Set<MessageListener>();
  const transportListeners = new Set<TransportListener>();

  const setTransport = (next: SignalingTransportState) => {
    if (transport === next) return;
    transport = next;
    for (const l of transportListeners) l(transport);
  };

  function connect(url: string): Promise<void> {
    if (socket && (transport === "connecting" || transport === "connected")) {
      // Already connecting/connected — resolve to current state.
      return Promise.resolve();
    }
    closed = false;
    setTransport("connecting");
    return new Promise((resolve, reject) => {
      // Track promise settlement independently of `transport` so that a
      // browser firing `onerror` → `onclose` in sequence still lets us
      // reject (`onerror` flips transport to "error" before `onclose`
      // runs, so reading transport here would miss the open-failure
      // case).
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };
      let ws: WebSocketLike;
      try {
        ws = factory(url);
      } catch (err) {
        setTransport("error");
        settle(() => reject(err));
        return;
      }
      socket = ws;
      ws.onopen = () => {
        setTransport("connected");
        settle(() => resolve());
      };
      ws.onmessage = (event) => {
        if (typeof event.data !== "string") return;
        for (const l of messageListeners) l(event.data);
      };
      ws.onerror = () => {
        setTransport("error");
      };
      ws.onclose = () => {
        socket = null;
        setTransport(closed ? "disconnected" : "error");
        settle(() =>
          reject(new SignalingClientError("websocket closed before open")),
        );
      };
    });
  }

  function send(message: SignalingMessage): void {
    if (!socket || socket.readyState !== OPEN_STATE) {
      throw new SignalingClientError(
        `cannot send: websocket not open (transport=${transport})`,
      );
    }
    // Defence in depth: validate outbound messages against the shared
    // Zod schema so malformed producers are caught locally before the
    // server has to reject them.
    const parsed = signalingMessageSchema.safeParse(message);
    if (!parsed.success) {
      throw new SignalingClientError(
        `outbound message failed schema validation: ${parsed.error.message}`,
      );
    }
    socket.send(JSON.stringify(parsed.data));
  }

  function onMessage(listener: MessageListener): () => void {
    messageListeners.add(listener);
    return () => messageListeners.delete(listener);
  }

  function onTransportChange(listener: TransportListener): () => void {
    transportListeners.add(listener);
    // Deliberately no synchronous emit on subscribe — that would turn
    // every mount into a fake "transport → <current>" log entry
    // (doubled under StrictMode). Consumers that need the current
    // value should call getTransportState() directly.
    return () => transportListeners.delete(listener);
  }

  function getTransportState(): SignalingTransportState {
    return transport;
  }

  function close(code?: number, reason?: string): void {
    closed = true;
    const sock = socket;
    socket = null;
    if (sock) {
      try {
        sock.close(code, reason);
      } catch {
        // ignore; idempotent close
      }
    }
    setTransport("disconnected");
  }

  return {
    connect,
    send,
    onMessage,
    onTransportChange,
    getTransportState,
    close,
  };
}
