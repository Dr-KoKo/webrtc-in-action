// LocalVideo — renders the local MediaStream from the ref owned by
// LocalMediaProvider (Phase 6 T045).
//
// The stream object never flows through React state; we re-bind
// `srcObject` only when `streamVersion` changes. The element is muted
// on purpose so the local preview never echoes the user's voice
// (FR-008 / quickstart).

import { useEffect, useRef } from "react";
import { useLocalMedia } from "../webrtc/local-media-provider";

export function LocalVideo() {
  const { getStream, streamVersion, hasStream } = useLocalMedia();
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.srcObject = getStream();
    return () => {
      // Detach so the browser releases its hold on the stream when
      // the element unmounts or the stream is replaced.
      el.srcObject = null;
    };
  }, [getStream, streamVersion]);

  return (
    <section aria-labelledby="local-video-heading" className="local-video">
      <h2 id="local-video-heading">Local preview</h2>
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        aria-label="local camera preview"
        className="local-video__video"
      />
      {!hasStream && (
        <p className="local-video__placeholder">
          Camera preview appears after joining a room.
        </p>
      )}
    </section>
  );
}
