// Mesh WebSocket client (T031). Connects to `/ws/mesh` and exposes a
// thin observer surface to the rest of the mesh feature module.
//
// Scope (M4):
// - connect(url), send(message), onMessage(cb), close() — idempotent.
// - Outbound messages are Zod-validated against
//   `meshClientMessageSchema` so a malformed local producer is caught
//   in-process (NFR-003 defence-in-depth).
// - Transport-state observer surface mirrors the 001 client so the
//   `signalingTransport` field on `LocalParticipant` (data-model §B.1)
//   can be driven by callbacks.
// - No auto-reconnect (Spec Non-Goals): a closed transport stays
//   closed until the user re-initiates.
//
// Browser handles WS-level Ping/Pong frames transparently; this client
// never emits JSON ping/pong messages.

import {
  meshClientMessageSchema,
  type MeshClientMessage,
} from "../protocol/schema";

export type MeshTransportState =
  | "idle"
  | "connecting"
  | "open"
  | "closed"
  | "error";

type MessageListener = (raw: string) => void;
type TransportListener = (state: MeshTransportState) => void;

export interface MeshSignalingClient {
  connect(url: string): Promise<void>;
  send(message: MeshClientMessage): void;
  onMessage(listener: MessageListener): () => void;
  onTransportChange(listener: TransportListener): () => void;
  getTransportState(): MeshTransportState;
  close(code?: number, reason?: string): void;
}

export class MeshSignalingClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MeshSignalingClientError";
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

export function createMeshSignalingClient(
  factory: WebSocketFactory = defaultFactory,
): MeshSignalingClient {
  let socket: WebSocketLike | null = null;
  let transport: MeshTransportState = "idle";
  let closedByUser = false;
  const messageListeners = new Set<MessageListener>();
  const transportListeners = new Set<TransportListener>();

  const setTransport = (next: MeshTransportState) => {
    if (transport === next) return;
    transport = next;
    for (const l of transportListeners) l(transport);
  };

  function connect(url: string): Promise<void> {
    if (socket && (transport === "connecting" || transport === "open")) {
      return Promise.resolve();
    }
    closedByUser = false;
    setTransport("connecting");
    return new Promise((resolve, reject) => {
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
        setTransport("open");
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
        setTransport(closedByUser ? "closed" : "error");
        settle(() =>
          reject(
            new MeshSignalingClientError("websocket closed before open"),
          ),
        );
      };
    });
  }

  function send(message: MeshClientMessage): void {
    if (!socket || socket.readyState !== OPEN_STATE) {
      throw new MeshSignalingClientError(
        `cannot send: websocket not open (transport=${transport})`,
      );
    }
    const parsed = meshClientMessageSchema.safeParse(message);
    if (!parsed.success) {
      throw new MeshSignalingClientError(
        `outbound mesh message failed schema validation: ${parsed.error.message}`,
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
    return () => transportListeners.delete(listener);
  }

  function getTransportState(): MeshTransportState {
    return transport;
  }

  function close(code?: number, reason?: string): void {
    closedByUser = true;
    const sock = socket;
    socket = null;
    if (sock) {
      try {
        sock.close(code, reason);
      } catch {
        // idempotent close
      }
    }
    setTransport("closed");
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
