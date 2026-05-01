// DataChannel ownership rule (T047, FR-050).
//
// The offerer creates the channel BEFORE createOffer so the resulting
// SDP carries the data m-line. The answerer registers
// `pc.ondatachannel` and stores the inbound channel reference. M6
// establishes ownership only — chat sending/receiving and the UI layer
// land in M8 (T062–T067).
//
// Both helpers are tiny on purpose: they let the unit tests assert the
// "createDataChannel called BEFORE createOffer" ordering by spying on
// the call sequence.

import type { MeshPairContext } from "./pairContext";

export const MESH_CHAT_CHANNEL_LABEL = "mesh-chat";

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
