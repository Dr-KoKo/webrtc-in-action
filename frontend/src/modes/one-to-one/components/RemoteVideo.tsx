// RemoteVideo — Phase 8 (T060).
//
// Renders the aggregated remote MediaStream owned by
// `PeerConnectionProvider`. Same DI shape as `LocalVideo`: the stream
// never flows through React state; we re-bind `srcObject` only when
// `remoteStreamVersion` changes (bumped on every `ontrack` event).
//
// Unlike the local preview, the remote element is NOT muted (we need
// the peer's audio) and autoplays after a user gesture in the same
// session — `playsInline` is required on iOS Safari.

import { useEffect, useRef } from "react";
import { usePeerConnection } from "../webrtc/peer-connection-provider";

export function RemoteVideo() {
  const { getRemoteStream, remoteStreamVersion, hasRemoteStream } =
    usePeerConnection();
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.srcObject = getRemoteStream();
    return () => {
      el.srcObject = null;
    };
  }, [getRemoteStream, remoteStreamVersion]);

  return (
    <section aria-labelledby="remote-video-heading" className="remote-video">
      <h2 id="remote-video-heading">Remote peer</h2>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        aria-label="remote peer video"
        className="remote-video__video"
      />
      {!hasRemoteStream && (
        <p className="remote-video__placeholder">
          Remote video and audio appear once the call connects.
        </p>
      )}
    </section>
  );
}
