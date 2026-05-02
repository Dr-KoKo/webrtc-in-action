// PairContext — per-pair WebRTC state (data-model §B.3).
//
// One PairContext per pairId. The contract is intentionally minimal at
// M6: the manager allocates one RTCPeerConnection, attaches the local
// audio + video senders (reusing the same MediaStreamTracks across
// every pair, sender count invariant 2 × N−1 once everyone is paired),
// and records role + epoch + the negotiation FSM states.
//
// `dc` is set on the offerer immediately after createDataChannel;
// on the answerer it's filled when `pc.ondatachannel` fires. M6 only
// owns the channel — chat send/receive/UI lands in M8 (T062–T067).
//
// `pc` is exposed read-only to consumers (event-log subscribers, the
// future M7 ICE wiring) so they can read `signalingState` /
// `connectionState` without owning the lifecycle.

import type { IceBuffer } from "./iceBuffer";

export type MeshPairRole = "offerer" | "answerer";

export type MeshPairState =
  | "new"
  | "creating-offer"
  | "have-local-offer"
  | "have-remote-offer"
  | "creating-answer"
  | "have-local-answer"
  | "have-remote-answer"
  | "stable"
  | "failed"
  | "closed";

export interface MeshPairContext {
  readonly pairId: string;
  readonly pairEpoch: number;
  readonly role: MeshPairRole;
  readonly remotePeerId: string;
  readonly remoteAdmissionIndex: number;
  readonly pc: RTCPeerConnection;
  // Set on the offerer at allocation; filled on the answerer when
  // pc.ondatachannel fires. Optional in transient pre-fill states.
  dc: RTCDataChannel | null;
  // Senders are kept as references so the existing-pair stability
  // guard (T051) can assert they were not replaced when a newcomer
  // joined the room.
  readonly senders: ReadonlyArray<RTCRtpSender>;
  state: MeshPairState;
  // M7 — per-pair ICE buffer; holds inbound remote candidates that
  // arrive before pc.setRemoteDescription completes. Drained in order
  // once SRD resolves. `null` (end-of-candidates) is preserved.
  readonly iceBuffer: IceBuffer;
  // Has setRemoteDescription resolved on this pc? Lets the inbound
  // ICE handler decide buffer-vs-apply without inspecting the pc
  // (some test fakes treat `remoteDescription` as undefined).
  remoteDescriptionApplied: boolean;
  // Has the local candidate stream signaled end-of-candidates to the
  // remote? (event.candidate === null on pc.onicecandidate.)
  endOfLocalCandidatesSent: boolean;
  // Did the remote signal end-of-candidates to us?
  endOfRemoteCandidatesReceived: boolean;
  // M11 — set true when the local peer has emitted a `pair_failed` for
  // this attempt OR when an inbound `pair_failed` from the remote was
  // applied. Prevents double-emission on subsequent `connectionstate`
  // transitions (e.g. failed → closed during local close).
  failedReported: boolean;
  // M11 — set true between local `reconnectPair(pairId)` and the
  // server's response (`pair_reconnect_instruction` or an error with
  // matching pairId). Used to disable the per-pair Reconnect button.
  reconnectRequested: boolean;
}
