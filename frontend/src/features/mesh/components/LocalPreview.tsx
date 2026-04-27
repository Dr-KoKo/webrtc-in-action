// LocalPreview — renders the acquired MediaStream into a self-tile
// `<video>`. Muted because echo is the default for a user previewing
// their own mic. The stream subscription lives next to the controller
// in `../webrtc/mediaAcquisition.ts`.

import { useEffect, useRef } from "react";
import { subscribeLocalStream } from "../webrtc/mediaAcquisition";

export function LocalPreview() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    return subscribeLocalStream((stream) => {
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
    });
  }, []);
  return (
    <section
      aria-labelledby="mesh-local-preview-heading"
      className="mesh-local-preview"
      data-testid="mesh-local-preview"
    >
      <h2 id="mesh-local-preview-heading">Self preview</h2>
      <video
        ref={videoRef}
        muted
        autoPlay
        playsInline
        data-testid="mesh-local-preview-video"
      />
    </section>
  );
}
