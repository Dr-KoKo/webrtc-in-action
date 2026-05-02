// RTCPeerConnection wrapper — Phase 7 (T050–T054) + Phase 8 (T057/T060).
//
// Centralizes construction + lifecycle of the browser's
// `RTCPeerConnection` + the offerer's `RTCDataChannel("chat")`. Keeps
// browser objects out of reducer state (per repository-shape guidance
// and data-model §B.4 / §B.5) — the handle below is held in a ref by
// `PeerConnectionProvider`.
//
// Scope (Phase 7 + Phase 8):
// - Construct the PC with server-provided `iceServers`.
// - `attachLocalTracks(stream)` — adds existing audio + video tracks.
// - Offerer-only `createChatDataChannel()` — must run BEFORE
//   `createOffer` so the SDP contains a data m-line (contract §3.7
//   + plan Phase 5 note + spec FR-016a).
// - `createOffer`, `applyOffer` (answerer: setRemote → createAnswer →
//   setLocal), `applyAnswer` (offerer: setRemote).
// - Wires the four getter-backing state listeners so the caller can
//   mirror them into the PeerConnectionSlice.
// - Phase 8 additions: `onIceCandidate` emits local candidates for
//   relay (null for end-of-candidates); `onTrack` delivers remote
//   tracks; `addRemoteIceCandidate` proxies `addIceCandidate` so the
//   provider + IceBuffer share one code path.
//
// Deferred to Phase 9:
// - DataChannel `onopen/onmessage` handling.

import type { PeerConnectionSnapshot } from "../state/peer-connection";

export type PeerConnectionRole = "offerer" | "answerer";

export interface PeerConnectionEvents {
  // Each callback is optional; providers can wire only the slots they
  // need. Phase 7 wires the four state getters + optional DC hook;
  // Phase 8 adds `onIceCandidate` (trickle ICE) and `onTrack`
  // (remote media delivery).
  onSignalingStateChange?: (state: RTCSignalingState) => void;
  onConnectionStateChange?: (state: RTCPeerConnectionState) => void;
  onIceConnectionStateChange?: (state: RTCIceConnectionState) => void;
  onIceGatheringStateChange?: (state: RTCIceGatheringState) => void;
  // Fired on the answerer when the offerer's pre-offer DataChannel
  // arrives. Phase 7 logs it for observability; Phase 9 will wire
  // `onmessage`.
  onDataChannel?: (dc: RTCDataChannel) => void;
  // Phase 8 (T057). Fired for every local candidate the browser
  // gathers, plus one final call with `null` signalling end-of-
  // candidates. Callers forward these verbatim over signaling per
  // contract §3.10.
  onIceCandidate?: (candidate: RTCIceCandidateInit | null) => void;
  // Phase 8 (T060). Fired once per remote track delivered via
  // `ontrack`. The caller aggregates audio+video into a single
  // remote `MediaStream`.
  onTrack?: (event: RTCTrackEvent) => void;
}

export interface CreatePeerConnectionOptions extends PeerConnectionEvents {
  iceServers: RTCIceServer[];
  role: PeerConnectionRole;
  // Test seam — production code uses the `RTCPeerConnection`
  // constructor. Kept narrow (`new (config) => RTCPeerConnection`) so
  // tests can inject a fake without duplicating the full constructor
  // signature.
  factory?: (config: RTCConfiguration) => RTCPeerConnection;
}

export interface PeerConnectionHandle {
  readonly role: PeerConnectionRole;
  readonly pc: RTCPeerConnection;
  /** Snapshot of the four getters at the moment of the call. */
  getSnapshot(): PeerConnectionSnapshot;
  /** Adds every live track from `stream` via `pc.addTrack`. */
  attachLocalTracks(stream: MediaStream): void;
  /**
   * Offerer-only. Creates the pre-offer DataChannel (labelled "chat").
   * MUST be called before `createOffer` so the SDP carries the data
   * m-line — otherwise DataChannel chat would require re-negotiation
   * later. Throws on the answerer side (not part of Phase 7 flow).
   */
  createChatDataChannel(): RTCDataChannel;
  /** Offerer: createOffer → setLocalDescription. Returns the SDP sent. */
  createOffer(): Promise<RTCSessionDescriptionInit>;
  /**
   * Answerer: setRemoteDescription(offer) → createAnswer →
   * setLocalDescription. Returns the answer SDP to send.
   */
  applyOffer(
    offer: RTCSessionDescriptionInit,
  ): Promise<RTCSessionDescriptionInit>;
  /** Offerer: setRemoteDescription(answer). */
  applyAnswer(answer: RTCSessionDescriptionInit): Promise<void>;
  /**
   * Adds a remote ICE candidate (Phase 8). The caller is responsible
   * for buffering vs. immediate apply (see `IceBuffer`); this method
   * is a thin proxy so the IceBuffer can inject a test fake.
   */
  addRemoteIceCandidate(candidate: RTCIceCandidateInit): Promise<void>;
  /** Closes the PC, releases listeners, idempotent. */
  close(): void;
}

export class PeerConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PeerConnectionError";
  }
}

const defaultFactory = (config: RTCConfiguration): RTCPeerConnection =>
  new RTCPeerConnection(config);

/**
 * Build an `RTCSessionDescriptionInit` that satisfies
 * `exactOptionalPropertyTypes: true` — the DOM type marks `sdp` as
 * optional, so we must omit the key entirely when the browser gave us
 * no body, rather than set it to `undefined`.
 */
function resolveDescription(
  primary: RTCSessionDescription | null,
  fallback: RTCSessionDescriptionInit,
  kind: "offer" | "answer",
): RTCSessionDescriptionInit {
  const type = primary?.type ?? fallback.type ?? kind;
  const sdp = primary?.sdp ?? fallback.sdp;
  return sdp === undefined ? { type } : { type, sdp };
}

export function createPeerConnection(
  options: CreatePeerConnectionOptions,
): PeerConnectionHandle {
  const factory = options.factory ?? defaultFactory;
  const pc = factory({ iceServers: options.iceServers });
  let closed = false;

  // State listeners — thin pass-throughs. We deliberately do NOT cache
  // the last-seen value; the reducer is authoritative and the PC's
  // getter is the only source of truth at fire time.
  if (options.onSignalingStateChange) {
    const cb = options.onSignalingStateChange;
    pc.addEventListener("signalingstatechange", () => {
      cb(pc.signalingState);
    });
  }
  if (options.onConnectionStateChange) {
    const cb = options.onConnectionStateChange;
    pc.addEventListener("connectionstatechange", () => {
      cb(pc.connectionState);
    });
  }
  if (options.onIceConnectionStateChange) {
    const cb = options.onIceConnectionStateChange;
    pc.addEventListener("iceconnectionstatechange", () => {
      cb(pc.iceConnectionState);
    });
  }
  if (options.onIceGatheringStateChange) {
    const cb = options.onIceGatheringStateChange;
    pc.addEventListener("icegatheringstatechange", () => {
      cb(pc.iceGatheringState);
    });
  }
  if (options.onDataChannel) {
    const cb = options.onDataChannel;
    pc.addEventListener("datachannel", (ev) => {
      cb(ev.channel);
    });
  }
  if (options.onIceCandidate) {
    const cb = options.onIceCandidate;
    pc.addEventListener("icecandidate", (ev) => {
      // `event.candidate === null` signals end-of-candidates per the
      // WebRTC spec. We forward that sentinel to the callback so the
      // provider can relay it as `{candidate: null}` (contract §3.10).
      // A candidate with `candidate === ""` is technically legal per
      // the DOM type but is treated as malformed by our signaling
      // layer; the provider converts it into the null marker.
      if (ev.candidate === null) {
        cb(null);
        return;
      }
      // `RTCIceCandidate.toJSON` returns exactly the
      // `RTCIceCandidateInit` shape the contract expects. We avoid
      // hand-mapping fields so future spec additions (e.g.,
      // `relayProtocol`) flow through unchanged.
      cb(ev.candidate.toJSON());
    });
  }
  if (options.onTrack) {
    const cb = options.onTrack;
    pc.addEventListener("track", (ev) => {
      cb(ev);
    });
  }

  function requireOfferer(action: string): void {
    if (options.role !== "offerer") {
      throw new PeerConnectionError(
        `${action} is offerer-only (current role=${options.role})`,
      );
    }
  }
  function requireAnswerer(action: string): void {
    if (options.role !== "answerer") {
      throw new PeerConnectionError(
        `${action} is answerer-only (current role=${options.role})`,
      );
    }
  }
  function requireOpen(action: string): void {
    if (closed) {
      throw new PeerConnectionError(
        `${action} called after PeerConnection was closed`,
      );
    }
  }

  return {
    role: options.role,
    pc,
    getSnapshot(): PeerConnectionSnapshot {
      return {
        connectionState: pc.connectionState,
        iceConnectionState: pc.iceConnectionState,
        iceGatheringState: pc.iceGatheringState,
        signalingState: pc.signalingState,
      };
    },
    attachLocalTracks(stream: MediaStream): void {
      requireOpen("attachLocalTracks");
      for (const track of stream.getTracks()) {
        pc.addTrack(track, stream);
      }
    },
    createChatDataChannel(): RTCDataChannel {
      requireOpen("createChatDataChannel");
      requireOfferer("createChatDataChannel");
      // Label "chat" is the single canonical label; Phase 9 opens the
      // channel for user-sent messages. Negotiated:false (default) so
      // the answerer receives it via `ondatachannel`.
      return pc.createDataChannel("chat");
    },
    async createOffer(): Promise<RTCSessionDescriptionInit> {
      requireOpen("createOffer");
      requireOfferer("createOffer");
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      // Return the description we actually set — `pc.localDescription`
      // may differ slightly from the pre-set value after munging.
      return resolveDescription(pc.localDescription, offer, "offer");
    },
    async applyOffer(
      offer: RTCSessionDescriptionInit,
    ): Promise<RTCSessionDescriptionInit> {
      requireOpen("applyOffer");
      requireAnswerer("applyOffer");
      await pc.setRemoteDescription(offer);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      return resolveDescription(pc.localDescription, answer, "answer");
    },
    async applyAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
      requireOpen("applyAnswer");
      requireOfferer("applyAnswer");
      await pc.setRemoteDescription(answer);
    },
    async addRemoteIceCandidate(
      candidate: RTCIceCandidateInit,
    ): Promise<void> {
      requireOpen("addRemoteIceCandidate");
      await pc.addIceCandidate(candidate);
    },
    close(): void {
      if (closed) return;
      closed = true;
      try {
        pc.close();
      } catch {
        // idempotent close
      }
    },
  };
}
