// Shared test fixtures for the M6 pair-manager specs (T053).
// jsdom does not provide RTCPeerConnection / RTCDataChannel, so we
// supply a minimal fake covering everything `pairManager.ts` exercises:
//   - addTrack(), createDataChannel(), createOffer(), createAnswer(),
//     setLocalDescription(), setRemoteDescription(), close()
//   - signalingState transitions through "have-local-offer" /
//     "have-remote-offer" / "stable" with onsignalingstatechange firing.
//   - ondatachannel firing on the answerer when the offerer's channel
//     is wired in.
//
// The fakes are deliberately decoupled (no shared globals) — every
// test starts with a fresh manager + factory.

import type {
  MeshLocalMediaSource,
  MeshPeerConnectionFactory,
} from "../webrtc/pairManager";

export class FakeRTCDataChannel {
  public readyState: RTCDataChannelState = "connecting";
  public readonly label: string;
  public readonly ordered: boolean;
  constructor(label: string, ordered: boolean) {
    this.label = label;
    this.ordered = ordered;
  }
}

export class FakeRTCSessionDescription {
  public readonly type: RTCSdpType;
  public readonly sdp: string;
  constructor(type: RTCSdpType, sdp: string) {
    this.type = type;
    this.sdp = sdp;
  }
}

export interface FakePCSpy {
  readonly callOrder: string[];
  // The channel the offerer created (if any).
  readonly createdChannels: FakeRTCDataChannel[];
  readonly addedTracks: MediaStreamTrack[];
  readonly senders: RTCRtpSender[];
}

export class FakeRTCPeerConnection {
  public signalingState: RTCSignalingState = "stable";
  public localDescription: RTCSessionDescription | null = null;
  public remoteDescription: RTCSessionDescription | null = null;
  public ondatachannel: ((event: RTCDataChannelEvent) => void) | null = null;
  public onsignalingstatechange: (() => void) | null = null;
  public connectionState: RTCPeerConnectionState = "new";
  private _spy: FakePCSpy;
  // Public so a peer instance can deliver a synthetic data-channel.
  public deliverDataChannel(dc: FakeRTCDataChannel): void {
    if (this.ondatachannel) {
      this.ondatachannel({ channel: dc as unknown as RTCDataChannel } as RTCDataChannelEvent);
    }
  }

  constructor(_cfg: RTCConfiguration | undefined, spy: FakePCSpy) {
    this._spy = spy;
  }

  addTrack(track: MediaStreamTrack, _stream?: MediaStream): RTCRtpSender {
    this._spy.callOrder.push(`addTrack(${track.kind})`);
    this._spy.addedTracks.push(track);
    const sender = { track } as unknown as RTCRtpSender;
    this._spy.senders.push(sender);
    return sender;
  }

  createDataChannel(
    label: string,
    init?: RTCDataChannelInit,
  ): RTCDataChannel {
    this._spy.callOrder.push("createDataChannel");
    const dc = new FakeRTCDataChannel(label, init?.ordered ?? true);
    this._spy.createdChannels.push(dc);
    return dc as unknown as RTCDataChannel;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    this._spy.callOrder.push("createOffer");
    return { type: "offer", sdp: `fake-offer-sdp\n` };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    this._spy.callOrder.push("createAnswer");
    return { type: "answer", sdp: `fake-answer-sdp\n` };
  }

  async setLocalDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    this._spy.callOrder.push(`setLocalDescription(${desc.type})`);
    this.localDescription = new FakeRTCSessionDescription(
      desc.type as RTCSdpType,
      desc.sdp ?? "",
    ) as unknown as RTCSessionDescription;
    if (desc.type === "offer") this.signalingState = "have-local-offer";
    else if (desc.type === "answer") this.signalingState = "stable";
    this.onsignalingstatechange?.();
  }

  async setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    this._spy.callOrder.push(`setRemoteDescription(${desc.type})`);
    this.remoteDescription = new FakeRTCSessionDescription(
      desc.type as RTCSdpType,
      desc.sdp ?? "",
    ) as unknown as RTCSessionDescription;
    if (desc.type === "offer") this.signalingState = "have-remote-offer";
    else if (desc.type === "answer") this.signalingState = "stable";
    this.onsignalingstatechange?.();
  }

  close(): void {
    this._spy.callOrder.push("close");
    this.connectionState = "closed";
    this.signalingState = "closed";
  }
}

export interface PCFactoryHandle {
  readonly factory: MeshPeerConnectionFactory;
  readonly pcs: FakeRTCPeerConnection[];
  readonly spies: FakePCSpy[];
}

export function makePCFactory(): PCFactoryHandle {
  const pcs: FakeRTCPeerConnection[] = [];
  const spies: FakePCSpy[] = [];
  const factory: MeshPeerConnectionFactory = (cfg) => {
    const spy: FakePCSpy = {
      callOrder: [],
      createdChannels: [],
      addedTracks: [],
      senders: [],
    };
    const pc = new FakeRTCPeerConnection(cfg, spy);
    pcs.push(pc);
    spies.push(spy);
    return pc as unknown as RTCPeerConnection;
  };
  return { factory, pcs, spies };
}

// fakeMediaSource — returns the supplied tracks each call (callers
// pass the SAME array across pair allocations to assert reuse).
export function fakeMediaSource(
  tracks: MediaStreamTrack[],
): MeshLocalMediaSource {
  return {
    getTracks: () => tracks,
    // M6 reuse-track assertions don't need a real MediaStream id, so
    // null is fine — pairManager passes through to addTrack(track) as a
    // single-arg call when stream is null.
    getStream: () => null,
  };
}

export function fakeAudioTrack(id = "a-1"): MediaStreamTrack {
  return { kind: "audio", id, enabled: true } as unknown as MediaStreamTrack;
}

export function fakeVideoTrack(id = "v-1"): MediaStreamTrack {
  return { kind: "video", id, enabled: true } as unknown as MediaStreamTrack;
}
