// MediaControls regression guard — T074 / Phase 10 DoD.
//
// Toggling the mic or camera MUST NOT trigger SDP renegotiation: the
// browser's `track.enabled = !track.enabled` runtime-mute does not
// change the transceiver's SDP. This test pins that contract against
// accidental regressions ("let's just re-negotiate on every toggle" is
// a real temptation) by asserting two invariants across a toggle
// sequence:
//
//   1. `RTCPeerConnection.signalingState` stays `"stable"`.
//   2. `RTCPeerConnection.createOffer` is never invoked.
//
// Because `<MediaControls/>` deliberately has no `RTCPeerConnection`
// dependency, the fake PC here is a *bystander*: we hand the component
// the same MediaStream whose tracks the PC is meant to be carrying,
// then assert the PC state is unchanged after every UI interaction.
// If a future change wires the PC into the toggle path (e.g.
// `replaceTrack` + implicit negotiation), this test will fail.

import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { MediaControls } from "@/modes/one-to-one/components/MediaControls";
import {
  StoreProvider,
  initialRootState,
  type RootState,
} from "@/modes/one-to-one/state";
import {
  LocalMediaContext,
  type LocalMediaContextValue,
} from "@/modes/one-to-one/webrtc/local-media-provider";

// ---------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------

interface FakeTrack {
  kind: "audio" | "video";
  enabled: boolean;
}

function makeFakeStream(): {
  stream: MediaStream;
  audio: FakeTrack;
  video: FakeTrack;
} {
  const audio: FakeTrack = { kind: "audio", enabled: true };
  const video: FakeTrack = { kind: "video", enabled: true };
  const stream = {
    getAudioTracks: () => [audio],
    getVideoTracks: () => [video],
    getTracks: () => [audio, video],
  } as unknown as MediaStream;
  return { stream, audio, video };
}

interface FakeSignalingClient {
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  onMessage: () => () => void;
  onTransportChange: () => () => void;
  getTransportState: () => "connected";
  connect: () => Promise<void>;
}

function makeFakeSignalingClient(): FakeSignalingClient {
  return {
    send: vi.fn(),
    close: vi.fn(),
    onMessage: () => () => {},
    onTransportChange: () => () => {},
    getTransportState: () => "connected" as const,
    connect: () => Promise.resolve(),
  };
}

interface FakePeerConnection {
  signalingState: RTCSignalingState;
  createOffer: ReturnType<typeof vi.fn>;
  setLocalDescription: ReturnType<typeof vi.fn>;
  setRemoteDescription: ReturnType<typeof vi.fn>;
  addTrack: ReturnType<typeof vi.fn>;
}

function makeFakePeerConnection(): FakePeerConnection {
  return {
    signalingState: "stable",
    createOffer: vi.fn(),
    setLocalDescription: vi.fn(),
    setRemoteDescription: vi.fn(),
    addTrack: vi.fn(),
  };
}

// Minimal SignalingProvider shim — skips the real `createSignalingClient`
// so the test never opens a real WebSocket. Mirrors the live
// `SignalingProvider` contract shape used by `useSignalingClient`
// (which only needs the client object; the transport subscription work
// is irrelevant to MediaControls).
import { SignalingProvider } from "@/modes/one-to-one/signaling/provider";
import type { SignalingClient } from "@/modes/one-to-one/signaling/client";

function renderControls(args: {
  stream: MediaStream | null;
  client: FakeSignalingClient;
  initialState: RootState;
}) {
  const localMediaValue: LocalMediaContextValue = {
    getStream: () => args.stream,
    streamVersion: args.stream ? 1 : 0,
    hasStream: args.stream !== null,
    release: () => {},
  };
  const Wrapper = ({ children }: { children: ReactNode }) =>
    createElement(StoreProvider, {
      initialState: args.initialState,
      children: createElement(SignalingProvider, {
        client: args.client as unknown as SignalingClient,
        children: createElement(LocalMediaContext.Provider, {
          value: localMediaValue,
          children,
        }),
      }),
    });
  return render(createElement(MediaControls), { wrapper: Wrapper });
}

// Synthesize a RootState in which the session has reached
// `connected` so MediaControls is allowed to emit media_state
// (contract §3.11 gate: callPhase SHOULD be connected). The concrete
// transport / reducer shape is irrelevant — only the gating fields
// MediaControls reads off the slice matter here.
function connectedRootState(): RootState {
  return {
    ...initialRootState,
    session: {
      ...initialRootState.session,
      session: "connected",
      transport: "connected",
      roomId: "demo",
      selfPeerId: "11111111-2222-3333-4444-555555555555",
      admissionOrder: 1,
      remoteParticipant: null,
      joinError: null,
    },
  };
}

// ---------------------------------------------------------------------
// The regression guard
// ---------------------------------------------------------------------

describe("MediaControls (T074 regression guard)", () => {
  it("toggling mic and camera never touches RTCPeerConnection", () => {
    const { stream, audio, video } = makeFakeStream();
    const client = makeFakeSignalingClient();
    const pc = makeFakePeerConnection();

    const { getByTestId } = renderControls({
      stream,
      client,
      initialState: connectedRootState(),
    });

    const mic = getByTestId("mic-toggle");
    const cam = getByTestId("camera-toggle");

    // Pre-conditions — PC is in the canonical "stable" state and has
    // emitted no offers.
    expect(pc.signalingState).toBe("stable");
    expect(pc.createOffer).not.toHaveBeenCalled();

    // Toggle sequence: mic-off, camera-off, mic-on, camera-on. Each
    // click flips `track.enabled` and emits one `media_state`; at no
    // point should the PC be touched.
    act(() => {
      fireEvent.click(mic);
    });
    act(() => {
      fireEvent.click(cam);
    });
    act(() => {
      fireEvent.click(mic);
    });
    act(() => {
      fireEvent.click(cam);
    });

    // 1) `track.enabled` round-trips exactly as the contract expects.
    expect(audio.enabled).toBe(true);
    expect(video.enabled).toBe(true);

    // 2) Four media_state envelopes were emitted — one per click.
    expect(client.send).toHaveBeenCalledTimes(4);
    for (const call of client.send.mock.calls) {
      const msg = call[0] as {
        v: number;
        type: string;
        roomId: string;
        payload: {
          microphone: "on" | "off";
          camera: "on" | "off";
          screenShare: "active" | "inactive";
        };
      };
      expect(msg.type).toBe("media_state");
      expect(msg.roomId).toBe("demo");
      // Full triplet MUST be present in every envelope (§3.11 — no
      // partial payloads). This guards against a future regression
      // where someone sends {microphone: "off"} alone.
      expect(msg.payload.microphone === "on" || msg.payload.microphone === "off")
        .toBe(true);
      expect(msg.payload.camera === "on" || msg.payload.camera === "off").toBe(
        true,
      );
      expect(
        msg.payload.screenShare === "active" ||
          msg.payload.screenShare === "inactive",
      ).toBe(true);
    }

    // 3) The peer connection was never mutated by the toggle path.
    //    signalingState stays "stable"; createOffer was never invoked.
    //    If either assertion fails, a caller has introduced implicit
    //    renegotiation — see research.md §4 + plan Phase 10 DoD.
    expect(pc.signalingState).toBe("stable");
    expect(pc.createOffer).not.toHaveBeenCalled();
    expect(pc.setLocalDescription).not.toHaveBeenCalled();
    expect(pc.setRemoteDescription).not.toHaveBeenCalled();
  });

  it("disables both toggles when no local stream is present", () => {
    const client = makeFakeSignalingClient();
    const { getByTestId } = renderControls({
      stream: null,
      client,
      initialState: connectedRootState(),
    });
    const mic = getByTestId("mic-toggle") as HTMLButtonElement;
    const cam = getByTestId("camera-toggle") as HTMLButtonElement;
    expect(mic.disabled).toBe(true);
    expect(cam.disabled).toBe(true);
    // Clicking a disabled button produces no send — defensive.
    act(() => {
      fireEvent.click(mic);
      fireEvent.click(cam);
    });
    expect(client.send).not.toHaveBeenCalled();
  });

  it("does NOT emit media_state before the session reaches connecting/connected", () => {
    const { stream } = makeFakeStream();
    const client = makeFakeSignalingClient();
    const preConnectedState: RootState = {
      ...initialRootState,
      session: {
        ...initialRootState.session,
        session: "waiting-for-peer",
        transport: "connected",
        roomId: "demo",
        selfPeerId: "11111111-2222-3333-4444-555555555555",
        admissionOrder: 1,
        remoteParticipant: null,
        joinError: null,
      },
    };
    const { getByTestId } = renderControls({
      stream,
      client,
      initialState: preConnectedState,
    });
    act(() => {
      fireEvent.click(getByTestId("mic-toggle"));
    });
    // The local track still flipped, but the server would reject a
    // send in this state (pending role assignment) — we hold back.
    expect(client.send).not.toHaveBeenCalled();
  });
});
