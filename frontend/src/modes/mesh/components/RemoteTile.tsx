// RemoteTile (T057 + T058). One tile per remote peer, rendering the
// L13 surface required by Constitution Principle V — every WebRTC
// lifecycle the user can observe is shown live, per-pair.
//
// Five state pills (FR-023, FR-064):
//   - connectionState
//   - iceConnectionState
//   - iceGatheringState
//   - signalingState
//   - dataChannel.readyState
//
// State is strictly pair-scoped. Two different remote tiles may
// legitimately show different states at the same time (FR-013a). The
// tile also renders the remote MediaStream attached on `pc.ontrack`
// (T058) — the <video> element's `srcObject` is set imperatively in
// an effect because React doesn't reflect MediaStream as an attribute.
//
// Roster presence (joined / media-ready / connecting / connected /
// failed) is shown alongside the pair pills so a viewer can tell
// "the other side is in the room" from "we have an established PC".

import { useEffect, useRef } from "react";
import type { MeshPairView } from "../state/pairs";
import type { Presence } from "../protocol/schema";
import {
  defaultRemoteMediaState,
  type RemoteMediaState,
} from "../state/roster";
import { ReconnectButton } from "./ReconnectButton";

const PRESENCE_LABEL: Record<Presence, string> = {
  joined: "joined",
  "media-ready": "media ready",
  connecting: "connecting",
  connected: "connected",
  failed: "failed",
  released: "released",
  left: "left",
};

export interface RemoteTileProps {
  // Remote peer identity (always present — even before a PairContext
  // exists, the tile renders so the user sees the roster entry).
  readonly peerId: string;
  readonly admissionIndex: number;
  readonly presence: Presence;
  // Pair view — `null` while the pair has not yet been allocated
  // (e.g. the remote peer is in `joined` but not yet `media-ready`).
  readonly pair: MeshPairView | null;
  // Remote media-state indicator (M9 / FR-033). Default is mic+camera
  // "on" / screen-share "inactive" so the tile renders meaningful pills
  // for peers that haven't toggled yet.
  readonly remoteMedia?: RemoteMediaState;
}

export function RemoteTile({
  peerId,
  admissionIndex,
  presence,
  pair,
  remoteMedia = defaultRemoteMediaState,
}: RemoteTileProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const stream = pair?.remoteStream ?? null;
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
    }
    if (audioRef.current) {
      audioRef.current.srcObject = stream;
    }
  }, [pair?.remoteStream]);

  return (
    <article
      className="mesh-remote-tile"
      data-testid={`mesh-remote-tile-${peerId}`}
      data-peer-id={peerId}
      data-pair-id={pair?.pairId ?? ""}
    >
      <header className="mesh-remote-tile__header">
        <span className="mesh-remote-tile__index">#{admissionIndex}</span>
        <span className="mesh-remote-tile__id">peer {short(peerId)}</span>
        <span
          className="mesh-remote-tile__presence"
          data-testid={`mesh-remote-tile-${peerId}-presence`}
          data-presence={presence}
        >
          {PRESENCE_LABEL[presence]}
        </span>
      </header>
      <div className="mesh-remote-tile__media">
        <video
          ref={videoRef}
          data-testid={`mesh-remote-tile-${peerId}-video`}
          autoPlay
          playsInline
          // Browsers gate autoplay on muted; the audio element below
          // carries the real audio track (separate gain control).
          muted
        />
        <audio
          ref={audioRef}
          data-testid={`mesh-remote-tile-${peerId}-audio`}
          autoPlay
        />
      </div>
      <ul className="mesh-remote-tile__pills" data-testid={`mesh-remote-tile-${peerId}-pills`}>
        <Pill
          label="connection"
          value={pair?.connectionState ?? "(no pair)"}
          testId={`mesh-remote-tile-${peerId}-connection-state`}
          dimmed={!pair}
        />
        <Pill
          label="iceConn"
          value={pair?.iceConnectionState ?? "(no pair)"}
          testId={`mesh-remote-tile-${peerId}-ice-connection-state`}
          dimmed={!pair}
        />
        <Pill
          label="iceGather"
          value={pair?.iceGatheringState ?? "(no pair)"}
          testId={`mesh-remote-tile-${peerId}-ice-gathering-state`}
          dimmed={!pair}
        />
        <Pill
          label="signaling"
          value={pair?.signalingState ?? "(no pair)"}
          testId={`mesh-remote-tile-${peerId}-signaling-state`}
          dimmed={!pair}
        />
        <Pill
          label="dataChannel"
          value={pair?.dataChannelState ?? "(no pair)"}
          testId={`mesh-remote-tile-${peerId}-data-channel-state`}
          dimmed={!pair}
        />
      </ul>
      <ul
        className="mesh-remote-tile__media"
        data-testid={`mesh-remote-tile-${peerId}-media-indicators`}
      >
        <Pill
          label="mic"
          value={remoteMedia.microphone}
          testId={`mesh-remote-tile-${peerId}-mic`}
        />
        <Pill
          label="camera"
          value={remoteMedia.camera}
          testId={`mesh-remote-tile-${peerId}-camera`}
        />
        <Pill
          label="screen"
          value={remoteMedia.screenShare}
          testId={`mesh-remote-tile-${peerId}-screen-share`}
        />
      </ul>
      {pair ? (
        <div
          className="mesh-remote-tile__actions"
          data-testid={`mesh-remote-tile-${peerId}-actions`}
        >
          <ReconnectButton pair={pair} />
        </div>
      ) : null}
    </article>
  );
}

interface PillProps {
  readonly label: string;
  readonly value: string;
  readonly testId: string;
  readonly dimmed?: boolean;
}

function Pill({ label, value, testId, dimmed }: PillProps) {
  return (
    <li
      className="mesh-remote-tile__pill"
      data-testid={testId}
      data-value={value}
      data-dimmed={dimmed ? "true" : "false"}
    >
      <span className="mesh-remote-tile__pill-label">{label}</span>
      <span className="mesh-remote-tile__pill-value">{value}</span>
    </li>
  );
}

function short(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}
