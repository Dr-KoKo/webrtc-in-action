// T057 / T058 — RemoteTile component spec. Verifies:
//   - five lifecycle pills render with the supplied PairView values
//   - pills update live when PairView is replaced
//   - the <video> / <audio> srcObject is the supplied MediaStream
//   - the tile renders a "(no pair)" placeholder before the pair is
//     allocated (e.g. remote peer in `joined`, not yet `media-ready`)

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { RemoteTile } from "../components/RemoteTile";
import type { MeshPairView } from "../state/pairs";

const PEER_B = "00000000-0000-4000-8000-000000000002";

function makeView(overrides: Partial<MeshPairView> = {}): MeshPairView {
  return {
    pairId: "1-2",
    pairEpoch: 1,
    role: "offerer",
    remotePeerId: PEER_B,
    remoteAdmissionIndex: 2,
    connectionState: "connected",
    iceConnectionState: "connected",
    iceGatheringState: "complete",
    signalingState: "stable",
    dataChannelState: "open",
    remoteStream: null,
    ...overrides,
  };
}

function pillValue(testId: string): string | null {
  return screen.getByTestId(testId).getAttribute("data-value");
}

describe("RemoteTile (T057)", () => {
  it("renders all five lifecycle pills with PairView values", () => {
    render(
      <RemoteTile
        peerId={PEER_B}
        admissionIndex={2}
        presence="connected"
        pair={makeView()}
      />,
    );
    expect(pillValue(`mesh-remote-tile-${PEER_B}-connection-state`)).toBe(
      "connected",
    );
    expect(pillValue(`mesh-remote-tile-${PEER_B}-ice-connection-state`)).toBe(
      "connected",
    );
    expect(pillValue(`mesh-remote-tile-${PEER_B}-ice-gathering-state`)).toBe(
      "complete",
    );
    expect(pillValue(`mesh-remote-tile-${PEER_B}-signaling-state`)).toBe(
      "stable",
    );
    expect(pillValue(`mesh-remote-tile-${PEER_B}-data-channel-state`)).toBe(
      "open",
    );
  });

  it("pills update live when PairView changes", () => {
    const { rerender } = render(
      <RemoteTile
        peerId={PEER_B}
        admissionIndex={2}
        presence="connecting"
        pair={makeView({
          connectionState: "connecting",
          iceConnectionState: "checking",
        })}
      />,
    );
    expect(pillValue(`mesh-remote-tile-${PEER_B}-connection-state`)).toBe(
      "connecting",
    );

    rerender(
      <RemoteTile
        peerId={PEER_B}
        admissionIndex={2}
        presence="connected"
        pair={makeView({
          connectionState: "connected",
          iceConnectionState: "connected",
        })}
      />,
    );
    expect(pillValue(`mesh-remote-tile-${PEER_B}-connection-state`)).toBe(
      "connected",
    );
    expect(pillValue(`mesh-remote-tile-${PEER_B}-ice-connection-state`)).toBe(
      "connected",
    );
  });

  it("attaches the remote MediaStream to <video> and <audio>", () => {
    const stream = {
      // jsdom doesn't implement MediaStream methods we care about — a
      // bare object is enough because the tile only assigns it to
      // srcObject.
      id: "remote-stream-1",
    } as unknown as MediaStream;
    render(
      <RemoteTile
        peerId={PEER_B}
        admissionIndex={2}
        presence="connected"
        pair={makeView({ remoteStream: stream })}
      />,
    );
    const video = screen.getByTestId(
      `mesh-remote-tile-${PEER_B}-video`,
    ) as HTMLVideoElement;
    const audio = screen.getByTestId(
      `mesh-remote-tile-${PEER_B}-audio`,
    ) as HTMLAudioElement;
    expect(video.srcObject).toBe(stream);
    expect(audio.srcObject).toBe(stream);
  });

  it("renders placeholder pills when no pair is allocated yet", () => {
    render(
      <RemoteTile
        peerId={PEER_B}
        admissionIndex={2}
        presence="joined"
        pair={null}
      />,
    );
    expect(pillValue(`mesh-remote-tile-${PEER_B}-connection-state`)).toBe(
      "(no pair)",
    );
    expect(pillValue(`mesh-remote-tile-${PEER_B}-data-channel-state`)).toBe(
      "(no pair)",
    );
  });
});
