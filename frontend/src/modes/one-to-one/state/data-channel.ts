// DataChannel slice — Phase 9 (T065/T066, data-model §B.5).
//
// Mirrors `RTCDataChannel.readyState` into a reducer-friendly enum
// `absent | connecting | open | closing | closed`. The live channel
// itself is kept in a ref owned by `PeerConnectionProvider`; this
// slice holds only the scalar state so UI indicators and the chat
// input's `disabled` gate can react via normal React re-renders.
//
// The initial value is `absent` — no channel has been created or
// received yet. Transitions between the other four values are driven
// by `readyState` events on the underlying channel (see
// `wrapDataChannel` in `webrtc/data-channel.ts`).

import type { DataChannelStateValue } from "../webrtc/data-channel";

export interface DataChannelSlice {
  readonly state: DataChannelStateValue;
}

export const initialDataChannelSlice: DataChannelSlice = {
  state: "absent",
};

export type DataChannelAction =
  | { type: "DATA_CHANNEL_STATE_CHANGED"; state: DataChannelStateValue }
  | { type: "DATA_CHANNEL_RESET" };

export function dataChannelReducer(
  state: DataChannelSlice,
  action: DataChannelAction,
): DataChannelSlice {
  switch (action.type) {
    case "DATA_CHANNEL_STATE_CHANGED":
      if (action.state === state.state) return state;
      return { state: action.state };
    case "DATA_CHANNEL_RESET":
      return initialDataChannelSlice;
    default: {
      const _exhaustive: never = action;
      void _exhaustive;
      return state;
    }
  }
}
