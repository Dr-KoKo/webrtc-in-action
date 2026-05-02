// Per-pairing runtime context shared by the 1:1 webrtc verbs
// (Phase D1 of the frontend rings refactor).
//
// The verbs (`negotiation.ts`, `trickle.ts`, `datachannel-attach.ts`)
// are free functions over this Ctx. The provider (still
// `peer-connection-provider.tsx` in D1 — collapsed in E1) constructs
// it once per mount and passes it to every verb call.

import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { OneToOneStore, RootState } from "../state/store";
import type { RootAction } from "../state";
import type { SignalingClient } from "../signaling/client";
import type { CreatePeerConnectionOptions, PeerConnectionHandle } from "./peer-connection";
import type { IceBuffer } from "./ice-buffer";
import type { DataChannelWrapper } from "./data-channel";
import type { LearningInspectorSnapshot } from "./learning-inspector";
import type { OneToOneLog } from "./log";

export type CleanupSource =
  | "local_leave"
  | "remote_peer_left"
  | "local_failure";

export interface OneToOneRefs {
  handle: MutableRefObject<PeerConnectionHandle | null>;
  iceBuffer: MutableRefObject<IceBuffer | null>;
  chatChannel: MutableRefObject<DataChannelWrapper | null>;
  remoteStream: MutableRefObject<MediaStream | null>;
  activeRoomId: MutableRefObject<string | null>;
  role: MutableRefObject<"offerer" | "answerer" | null>;
  session: MutableRefObject<RootState["session"]>;
  getLocalStream: MutableRefObject<() => MediaStream | null>;
}

export interface OneToOneCtx {
  // Direct store + dispatch — verbs may use either. Phase B1's compat
  // shim means `dispatch(action)` and `store.getState().method(...)`
  // produce identical state writes.
  store: OneToOneStore;
  dispatch: Dispatch<RootAction>;
  client: SignalingClient;
  log: OneToOneLog;

  refs: OneToOneRefs;

  // React-state side hooks. The provider wires these to its
  // useState setters; the verbs poke them when their work changes
  // remote-stream-version or the inspector snapshot.
  bumpRemoteVersion(): void;
  setInspector(update: SetStateAction<LearningInspectorSnapshot>): void;

  // Construction options for new PCs. Test seam.
  peerConnectionFactory?: CreatePeerConnectionOptions["factory"];

  // Verb-shared helpers that don't fit a single verb file.
  attachChatDataChannel(
    channel: RTCDataChannel,
    origin: "offerer" | "answerer",
  ): void;
  teardownPeerConnection(source: CleanupSource): void;
}
