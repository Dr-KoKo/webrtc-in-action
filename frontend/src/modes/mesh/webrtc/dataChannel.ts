// DataChannel ownership + chat plumbing.
//
// M6 (T047, FR-050) — the offerer creates the channel BEFORE
// `pc.createOffer` so the resulting SDP carries the data m-line; the
// answerer registers `pc.ondatachannel` and stores the inbound channel
// reference. Both sides converge on `ctx.dc` once the negotiation
// reaches `signalingState=stable`.
//
// M8 (T062, T063, T066, FR-051..FR-055, L17) — the same per-pair
// channel carries group chat. There is exactly ONE chat DataChannel
// per peer-pair. We do NOT create a second channel for chat. We do
// NOT introduce a room-global DataChannel. We do NOT route final-MVP
// chat through `/ws/mesh`. Every chat-event log entry carries
// `transport: "datachannel"` (FR-053).

import type { Dispatch } from "react";
import type { MeshRootAction } from "../state";
import { makeMeshEventEntry } from "../state/eventLog";
import type {
  MeshChatFanOut,
  MeshChatMessage,
  MeshChatSkippedPeer,
} from "../state/chat";
import type { MeshPairContext } from "./pairContext";

export const MESH_CHAT_CHANNEL_LABEL = "mesh-chat";

// Wire payload for a single chat message. The shape is intentionally
// flat and serializable; the receiver validates every field before
// touching state. `kind` is fixed so a future non-chat message kind
// over the same channel can be discriminated cleanly without wrecking
// the chat path.
export const MESH_CHAT_PAYLOAD_KIND = "mesh_chat_message" as const;

export interface MeshChatWirePayload {
  readonly kind: typeof MESH_CHAT_PAYLOAD_KIND;
  readonly messageId: string;
  readonly roomId: string;
  readonly senderPeerId: string;
  readonly text: string;
  readonly sentAt: number;
}

export interface CreateMeshDataChannelOptions {
  readonly label?: string;
  readonly ordered?: boolean;
}

// createOffererDataChannel — call this on the offerer's PairContext
// before invoking pc.createOffer. The returned channel is attached
// to the context so the answerer-side code path is symmetric (read
// `ctx.dc` regardless of role once the negotiation reaches stable).
export function createOffererDataChannel(
  ctx: MeshPairContext,
  options: CreateMeshDataChannelOptions = {},
): RTCDataChannel {
  if (ctx.role !== "offerer") {
    throw new Error(
      `createOffererDataChannel called on ${ctx.role} for pair ${ctx.pairId}`,
    );
  }
  if (ctx.dc) {
    return ctx.dc;
  }
  const dc = ctx.pc.createDataChannel(options.label ?? MESH_CHAT_CHANNEL_LABEL, {
    ordered: options.ordered ?? true,
  });
  ctx.dc = dc;
  return dc;
}

// attachAnswererDataChannelHandler — registers `pc.ondatachannel` on
// the answerer's PairContext. The supplied callback fires once the
// remote (offerer) channel arrives. M6 only attaches the channel
// reference; M8 hooks `onmessage` for chat semantics.
export function attachAnswererDataChannelHandler(
  ctx: MeshPairContext,
  onChannel: (dc: RTCDataChannel) => void,
): void {
  if (ctx.role !== "answerer") {
    throw new Error(
      `attachAnswererDataChannelHandler called on ${ctx.role} for pair ${ctx.pairId}`,
    );
  }
  ctx.pc.ondatachannel = (event) => {
    if (!event?.channel) return;
    if (ctx.dc) {
      // Idempotent on the JS-API level; if the offerer somehow
      // re-creates a channel mid-attempt we keep the first one we saw.
      return;
    }
    ctx.dc = event.channel;
    onChannel(event.channel);
  };
}

// ─── M8 chat receive ────────────────────────────────────────────────────

const MESH_CHAT_RECEIVER_FLAG = "__meshChatReceiverAttached__";

interface ChatReceiverMarkedChannel extends RTCDataChannel {
  [MESH_CHAT_RECEIVER_FLAG]?: boolean;
}

export interface AttachMeshChatReceiverDeps {
  readonly dispatch: Dispatch<MeshRootAction>;
  readonly pairId: string;
  readonly remotePeerId: string;
  readonly expectedRoomId: string;
  // Recipient clock; injectable for deterministic tests.
  readonly now?: () => number;
}

// attachMeshChatReceiver — registers `dc.onmessage` for one pair's
// chat channel. Idempotent at the dc-instance level: if the helper is
// invoked twice for the SAME RTCDataChannel reference, the second call
// is a no-op (FR-052a — never append duplicate messages on duplicate
// registration).
export function attachMeshChatReceiver(
  dc: RTCDataChannel,
  deps: AttachMeshChatReceiverDeps,
): void {
  const marked = dc as ChatReceiverMarkedChannel;
  if (marked[MESH_CHAT_RECEIVER_FLAG]) {
    return;
  }
  marked[MESH_CHAT_RECEIVER_FLAG] = true;
  const now = deps.now ?? (() => Date.now());

  dc.onmessage = (event: MessageEvent) => {
    let raw: unknown;
    try {
      raw = typeof event.data === "string" ? JSON.parse(event.data) : null;
    } catch (err) {
      logInvalidInbound(deps, "json_parse_failed", err, dc.readyState, event.data);
      return;
    }
    const parsed = parseChatPayload(raw);
    if (!parsed.ok) {
      logInvalidInbound(deps, parsed.reason, null, dc.readyState, raw);
      return;
    }
    if (parsed.value.roomId !== deps.expectedRoomId) {
      logInvalidInbound(
        deps,
        "room_id_mismatch",
        null,
        dc.readyState,
        { gotRoomId: parsed.value.roomId },
      );
      return;
    }
    const receivedAt = now();
    const message: MeshChatMessage = {
      id: parsed.value.messageId,
      authorPeerId: parsed.value.senderPeerId,
      text: parsed.value.text,
      sentAt: parsed.value.sentAt,
      receivedAt,
    };
    deps.dispatch({
      type: "MESH_CHAT_INBOUND_APPENDED",
      message,
    });
    deps.dispatch({
      type: "MESH_EVENT_APPEND",
      entry: makeMeshEventEntry({
        scope: "pair",
        type: "mesh_chat_message_received",
        summary: `chat message received (datachannel) (pair ${deps.pairId})`,
        peerId: deps.remotePeerId,
        pairId: deps.pairId,
        detail: {
          transport: "datachannel",
          messageId: parsed.value.messageId,
          senderPeerId: parsed.value.senderPeerId,
          textLength: parsed.value.text.length,
          sentAt: parsed.value.sentAt,
          receivedAt,
        },
      }),
    });
  };
}

type ParseResult =
  | { ok: true; value: MeshChatWirePayload }
  | { ok: false; reason: string };

function parseChatPayload(raw: unknown): ParseResult {
  if (!raw || typeof raw !== "object") {
    return { ok: false, reason: "payload_not_object" };
  }
  const r = raw as Record<string, unknown>;
  if (r.kind !== MESH_CHAT_PAYLOAD_KIND) {
    return { ok: false, reason: "unknown_kind" };
  }
  if (typeof r.messageId !== "string" || r.messageId.length === 0) {
    return { ok: false, reason: "missing_messageId" };
  }
  if (typeof r.roomId !== "string" || r.roomId.length === 0) {
    return { ok: false, reason: "missing_roomId" };
  }
  if (typeof r.senderPeerId !== "string" || r.senderPeerId.length === 0) {
    return { ok: false, reason: "missing_senderPeerId" };
  }
  if (typeof r.text !== "string") {
    return { ok: false, reason: "missing_text" };
  }
  if (typeof r.sentAt !== "number" || !Number.isFinite(r.sentAt)) {
    return { ok: false, reason: "missing_sentAt" };
  }
  return {
    ok: true,
    value: {
      kind: MESH_CHAT_PAYLOAD_KIND,
      messageId: r.messageId,
      roomId: r.roomId,
      senderPeerId: r.senderPeerId,
      text: r.text,
      sentAt: r.sentAt,
    },
  };
}

function logInvalidInbound(
  deps: AttachMeshChatReceiverDeps,
  reason: string,
  err: unknown,
  readyState: RTCDataChannelState,
  rawSample: unknown,
): void {
  // Defensive truncation: never log a raw message body larger than 80
  // chars. A malicious peer can blow our event log otherwise.
  let sample: string;
  try {
    sample = typeof rawSample === "string"
      ? rawSample
      : JSON.stringify(rawSample);
  } catch {
    sample = "(unserializable)";
  }
  if (sample.length > 80) sample = `${sample.slice(0, 80)}…`;

  deps.dispatch({
    type: "MESH_EVENT_APPEND",
    entry: makeMeshEventEntry({
      scope: "pair",
      type: "mesh_chat_message_received_invalid",
      summary: `chat message received: invalid payload (${reason}) (pair ${deps.pairId})`,
      peerId: deps.remotePeerId,
      pairId: deps.pairId,
      detail: {
        transport: "datachannel",
        reason,
        readyState,
        error: err instanceof Error ? err.message : err === null ? null : String(err),
        sample,
      },
    }),
  });
}

// ─── M8 chat send (fan-out) ─────────────────────────────────────────────

export interface MeshChatSendablePair {
  readonly pairId: string;
  readonly remotePeerId: string;
  readonly dc: RTCDataChannel | null;
}

export interface MeshChatFanOutInput {
  readonly messageId: string;
  readonly roomId: string;
  readonly senderPeerId: string;
  readonly text: string;
  readonly sentAt: number;
}

export interface FanOutMeshChatDeps {
  readonly dispatch: Dispatch<MeshRootAction>;
}

// fanOutMeshChat — iterate the pair list at the time of send. For
// each pair whose `dc.readyState === "open"` we serialize the wire
// payload and call `dc.send(...)`; for every other pair we record a
// skip with the current `readyState`. The result is the per-message
// fan-out summary (`attempted = succeeded + skipped.length`).
//
// Side effects: emits one `mesh_chat_message_sent` (success) or
// `mesh_chat_message_send_skipped` (skip) event-log entry per pair.
// The local-echo append is the caller's responsibility — we do NOT
// dispatch `MESH_CHAT_LOCAL_APPENDED` here so callers can decide the
// sequencing (data-model §B.5: local echo MUST appear before the
// per-pair sends complete; the UI does not wait for ACK).
export function fanOutMeshChat(
  pairs: ReadonlyArray<MeshChatSendablePair>,
  input: MeshChatFanOutInput,
  deps: FanOutMeshChatDeps,
): MeshChatFanOut {
  const wire: MeshChatWirePayload = {
    kind: MESH_CHAT_PAYLOAD_KIND,
    messageId: input.messageId,
    roomId: input.roomId,
    senderPeerId: input.senderPeerId,
    text: input.text,
    sentAt: input.sentAt,
  };
  const serialized = JSON.stringify(wire);
  let succeeded = 0;
  const skipped: MeshChatSkippedPeer[] = [];

  for (const pair of pairs) {
    const dc = pair.dc;
    const readyState: RTCDataChannelState | "pending" = dc?.readyState ?? "pending";
    if (dc && dc.readyState === "open") {
      try {
        dc.send(serialized);
      } catch (err) {
        // A live "open" channel that throws on send is treated as a
        // skip — the message did not reach the remote. We log the
        // error so the user can see why.
        skipped.push({
          remotePeerId: pair.remotePeerId,
          pairId: pair.pairId,
          reason: "datachannel_not_open",
          readyState: dc.readyState,
        });
        deps.dispatch({
          type: "MESH_EVENT_APPEND",
          entry: makeMeshEventEntry({
            scope: "pair",
            type: "mesh_chat_message_send_skipped",
            summary: `chat message send skipped (dc send threw) (pair ${pair.pairId})`,
            peerId: pair.remotePeerId,
            pairId: pair.pairId,
            detail: {
              transport: "datachannel",
              reason: "datachannel_send_threw",
              readyState: dc.readyState,
              messageId: input.messageId,
              error: err instanceof Error ? err.message : String(err),
            },
          }),
        });
        continue;
      }
      succeeded += 1;
      deps.dispatch({
        type: "MESH_EVENT_APPEND",
        entry: makeMeshEventEntry({
          scope: "pair",
          type: "mesh_chat_message_sent",
          summary: `chat message sent (datachannel) (pair ${pair.pairId})`,
          peerId: pair.remotePeerId,
          pairId: pair.pairId,
          detail: {
            transport: "datachannel",
            messageId: input.messageId,
            textLength: input.text.length,
            sentAt: input.sentAt,
            readyState: dc.readyState,
          },
        }),
      });
      continue;
    }
    skipped.push({
      remotePeerId: pair.remotePeerId,
      pairId: pair.pairId,
      reason: "datachannel_not_open",
      readyState,
    });
    deps.dispatch({
      type: "MESH_EVENT_APPEND",
      entry: makeMeshEventEntry({
        scope: "pair",
        type: "mesh_chat_message_send_skipped",
        summary: `chat message send skipped (dc not open) (pair ${pair.pairId})`,
        peerId: pair.remotePeerId,
        pairId: pair.pairId,
        detail: {
          transport: "datachannel",
          reason: "datachannel_not_open",
          readyState,
          messageId: input.messageId,
        },
      }),
    });
  }

  return {
    messageId: input.messageId,
    attempted: pairs.length,
    succeeded,
    skipped,
  };
}
