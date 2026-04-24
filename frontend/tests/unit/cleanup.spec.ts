// Phase 12 — client cleanup regression guards (T087).
//
// Locks the three cleanup paths from data-model §C.5 and the signaling
// -disconnect branching from §B.1.1. The invariants this file guards
// are high-value because violating any of them is a silent
// data-integrity or user-experience bug:
//
//   Path A must stop local tracks BEFORE closing the PC (§C.5). A
//   regression that swaps the order leaves the remote peer thinking
//   "remote hung up" only after it saw a fresh black frame rather
//   than a graceful track-ended event.
//
//   Path B must NEVER stop local tracks (§C.5). The "local camera off
//   when the remote hangs up" bug is the exact failure mode this
//   phase exists to prevent; the dedicated assertion below pins it.
//
//   Path B MUST NOT run when no PeerConnection exists (§3.12 + §C.6):
//   pending-media releases ride peer_presence_changed(presence=
//   "released") alone; a server bug that sent peer_left in that case
//   would trigger Path B against a non-existent PC. The client MUST
//   guard at the boundary.
//
//   Path C enters terminal `failed` only from {connecting, connected}
//   and renders a FailurePanel with Leave / Rejoin. Local tracks stay
//   live until the user clicks a button (§C.5 step 5).
//
//   Signaling-disconnect is its own axis, not a cleanup path:
//     pre-connected → `failed`; connected → transport=error warning,
//     session stays `connected` (media keeps flowing P2P, §B.1.1).

import { describe, expect, it, vi } from "vitest";
import { act, render, fireEvent } from "@testing-library/react";
import { createElement, useEffect, type ReactNode } from "react";
import {
  StoreProvider,
  initialRootState,
  useDispatch,
  useRootState,
  type RootState,
} from "../../src/state";
import {
  LocalMediaContext,
  type LocalMediaContextValue,
} from "../../src/webrtc/local-media-provider";
import {
  PeerConnectionContext,
  type PeerConnectionContextValue,
} from "../../src/webrtc/peer-connection-provider";
import type { PeerConnectionHandle } from "../../src/webrtc/peer-connection";
import {
  ScreenShareContext,
  type ScreenShareContextValue,
} from "../../src/webrtc/screen-share-provider";
import { CleanupProvider, useCleanup } from "../../src/webrtc/cleanup";
import { FailurePanel } from "../../src/components/FailurePanel";
import { SignalingProvider } from "../../src/signaling/provider";
import type { SignalingClient } from "../../src/signaling/client";
import { initialInspectorSnapshot } from "../../src/webrtc/learning-inspector";
import { CONTRACT_VERSION } from "../../src/types/contract";

// ---------------------------------------------------------------------
// Fake signaling client — the SignalingProvider sets up the dispatcher
// with this client, and CleanupProvider subscribes via onMessage and
// onTransportChange. Tests capture the registered callbacks so they
// can push inbound frames and transport transitions.
// ---------------------------------------------------------------------

interface FakeSignalingClient {
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  onMessage: (cb: (raw: string) => void) => () => void;
  onTransportChange: (
    cb: (
      t: "disconnected" | "connecting" | "connected" | "error",
    ) => void,
  ) => () => void;
  getTransportState: () => "connected";
  _pushInbound(frame: unknown): void;
  _pushTransport(
    t: "disconnected" | "connecting" | "connected" | "error",
  ): void;
}

function makeFakeClient(): FakeSignalingClient {
  const messageListeners = new Set<(raw: string) => void>();
  const transportListeners = new Set<
    (t: "disconnected" | "connecting" | "connected" | "error") => void
  >();
  const client: FakeSignalingClient = {
    send: vi.fn(),
    close: vi.fn(),
    connect: vi.fn(() => Promise.resolve()),
    onMessage: (cb) => {
      messageListeners.add(cb);
      return () => messageListeners.delete(cb);
    },
    onTransportChange: (cb) => {
      transportListeners.add(cb);
      return () => transportListeners.delete(cb);
    },
    getTransportState: () => "connected" as const,
    _pushInbound: (frame) => {
      const raw = JSON.stringify(frame);
      for (const cb of messageListeners) cb(raw);
    },
    _pushTransport: (t) => {
      for (const cb of transportListeners) cb(t);
    },
  };
  return client;
}

// ---------------------------------------------------------------------
// Fake MediaStreamTrack / MediaStream — just enough for the assertions
// below. stop() flips readyState from "live" → "ended".
// ---------------------------------------------------------------------

interface FakeTrack {
  kind: "audio" | "video";
  readyState: "live" | "ended";
  stop: ReturnType<typeof vi.fn>;
}

function makeTrack(kind: "audio" | "video"): FakeTrack {
  const t: FakeTrack = {
    kind,
    readyState: "live",
    stop: vi.fn(() => {
      t.readyState = "ended";
    }),
  };
  return t;
}

function makeStream(tracks: FakeTrack[]): MediaStream {
  return {
    getAudioTracks: () => tracks.filter((t) => t.kind === "audio"),
    getVideoTracks: () => tracks.filter((t) => t.kind === "video"),
    getTracks: () => tracks,
  } as unknown as MediaStream;
}

// ---------------------------------------------------------------------
// Fakes for LocalMediaContext / PeerConnectionContext / ScreenShareContext
// ---------------------------------------------------------------------

interface Harness {
  client: FakeSignalingClient;
  stream: MediaStream | null;
  tracks: FakeTrack[];
  localMediaRelease: ReturnType<typeof vi.fn>;
  teardownPeerConnection: ReturnType<typeof vi.fn>;
  screenShareStop: ReturnType<typeof vi.fn>;
  screenShareIsActive: ReturnType<typeof vi.fn>;
  getHandle: () => PeerConnectionHandle | null;
}

function makeHarness(opts: {
  hasPeerConnection?: boolean;
  screenShareActive?: boolean;
} = {}): Harness {
  const tracks = [makeTrack("audio"), makeTrack("video")];
  let stream: MediaStream | null = makeStream(tracks);
  const localMediaRelease = vi.fn(() => {
    stream = null;
    for (const t of tracks) t.stop();
  });
  const teardownPeerConnection = vi.fn<(source: string) => void>();
  const screenShareStop = vi.fn(() => Promise.resolve());
  const screenShareIsActive = vi.fn(() => !!opts.screenShareActive);
  const handle = opts.hasPeerConnection
    ? ({ pc: {} } as unknown as PeerConnectionHandle)
    : null;
  const client = makeFakeClient();
  return {
    client,
    get stream() {
      return stream;
    },
    tracks,
    localMediaRelease,
    teardownPeerConnection,
    screenShareStop,
    screenShareIsActive,
    getHandle: () => handle,
  } as Harness;
}

// ---------------------------------------------------------------------
// Root state builders — one per "from-state" the tests exercise.
// ---------------------------------------------------------------------

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
      remoteParticipant: {
        peerId: "aaaa2222-bbbb-cccc-dddd-eeeeffff0000",
        admissionOrder: 2,
        presence: "ready",
      },
    },
  };
}

function connectingRootState(): RootState {
  return {
    ...initialRootState,
    session: {
      ...initialRootState.session,
      session: "connecting",
      transport: "connected",
      roomId: "demo",
      selfPeerId: "11111111-2222-3333-4444-555555555555",
      admissionOrder: 1,
    },
  };
}

function pendingMediaRootState(): RootState {
  return {
    ...initialRootState,
    session: {
      ...initialRootState.session,
      session: "pending-media",
      transport: "connected",
      roomId: "demo",
      selfPeerId: "11111111-2222-3333-4444-555555555555",
      admissionOrder: 1,
    },
  };
}

function failedRootState(): RootState {
  return {
    ...initialRootState,
    session: {
      ...initialRootState.session,
      session: "failed",
      transport: "connected",
      roomId: "demo",
      selfPeerId: "11111111-2222-3333-4444-555555555555",
      admissionOrder: 1,
    },
  };
}

// ---------------------------------------------------------------------
// Render helper — wraps the provider tree with harness fakes so the
// CleanupProvider runs its real effects against the fake client /
// media / PC / screen-share contexts.
// ---------------------------------------------------------------------

function renderHarness(args: {
  harness: Harness;
  initialState: RootState;
  children: ReactNode;
}) {
  const localMediaValue: LocalMediaContextValue = {
    getStream: () => args.harness.stream,
    streamVersion: args.harness.stream ? 1 : 0,
    hasStream: args.harness.stream !== null,
    release: args.harness.localMediaRelease,
  };
  const pcValue: PeerConnectionContextValue = {
    getHandle: args.harness.getHandle,
    getRemoteStream: () => null,
    remoteStreamVersion: 0,
    hasRemoteStream: false,
    inspector: initialInspectorSnapshot,
    sendChatMessage: () => ({ ok: false, reason: "not-open" }),
    teardownPeerConnection: args.harness.teardownPeerConnection,
  };
  const screenShareValue: ScreenShareContextValue = {
    isActive: args.harness.screenShareIsActive,
    start: () => Promise.resolve({ ok: true as const }),
    stop: args.harness.screenShareStop,
  };
  const Tree = ({ children }: { children: ReactNode }) =>
    createElement(StoreProvider, {
      initialState: args.initialState,
      children: createElement(SignalingProvider, {
        client: args.harness.client as unknown as SignalingClient,
        children: createElement(LocalMediaContext.Provider, {
          value: localMediaValue,
          children: createElement(PeerConnectionContext.Provider, {
            value: pcValue,
            children: createElement(ScreenShareContext.Provider, {
              value: screenShareValue,
              children: createElement(CleanupProvider, {
                children,
              } as { children: ReactNode }),
            }),
          }),
        }),
      }),
    });
  return render(createElement(Tree, { children: args.children }));
}

// A tiny debug component that reads session state so tests can assert
// on reducer transitions via the rendered DOM.
function SessionProbe() {
  const { session } = useRootState();
  return createElement(
    "div",
    null,
    createElement("span", { "data-testid": "probe-session" }, session.session),
    createElement("span", { "data-testid": "probe-transport" }, session.transport),
  );
}

// Captures `useCleanup()` return value so tests can call leaveSession()
// / rejoin() imperatively. Calls `onReady` during render (safe — it
// only stores the API into a ref in the test).
function CleanupExposer({
  onReady,
}: {
  onReady: (api: ReturnType<typeof useCleanup>) => void;
}) {
  const api = useCleanup();
  useEffect(() => {
    onReady(api);
  }, [api, onReady]);
  return null;
}

// EventLogProbe renders the last 20 cleanup-related entries so tests
// can assert via text match without reaching into reducer internals.
function EventLogProbe() {
  const { eventLog } = useRootState();
  const entries = eventLog.entries.slice(-30);
  return createElement(
    "ul",
    { "data-testid": "event-log" },
    ...entries.map((e) =>
      createElement(
        "li",
        { key: e.id, "data-code": e.code ?? "", "data-type": e.type },
        `${e.type}|${e.code ?? ""}|${e.summary}`,
      ),
    ),
  );
}

// ---------------------------------------------------------------------
// Path A — local Leave
// ---------------------------------------------------------------------

describe("Path A — local Leave", () => {
  it("stops local tracks, closes DC+PC, sends leave_room, resets to idle, logs local_leave", async () => {
    const harness = makeHarness({ hasPeerConnection: true });
    let api: ReturnType<typeof useCleanup> | null = null;
    const { getByTestId } = renderHarness({
      harness,
      initialState: connectedRootState(),
      children: createElement(
        "div",
        null,
        createElement(SessionProbe),
        createElement(EventLogProbe),
        createElement(CleanupExposer, {
          onReady: (v) => {
            api = v;
          },
        }),
      ),
    });

    expect(api).not.toBeNull();
    expect(getByTestId("probe-session").textContent).toBe("connected");

    await act(async () => {
      await api!.leaveSession();
    });

    // Step 1: local tracks stopped (release called; all tracks ended).
    expect(harness.localMediaRelease).toHaveBeenCalledTimes(1);
    expect(harness.tracks.every((t) => t.readyState === "ended")).toBe(true);

    // Step 3+4: PC teardown called with source "local_leave". DC is
    // closed inside teardownPeerConnection; asserted by source label.
    expect(harness.teardownPeerConnection).toHaveBeenCalledTimes(1);
    expect(harness.teardownPeerConnection.mock.calls[0][0]).toBe("local_leave");

    // Step 5: leave_room sent on the WS.
    const leaveRoomCalls = harness.client.send.mock.calls
      .map((c) => c[0] as { type: string; roomId: string })
      .filter((m) => m.type === "leave_room");
    expect(leaveRoomCalls.length).toBe(1);
    expect(leaveRoomCalls[0].roomId).toBe("demo");

    // Step 7: WS closed.
    expect(harness.client.close).toHaveBeenCalled();

    // Step 8: reducer → idle.
    expect(getByTestId("probe-session").textContent).toBe("idle");

    // Step 9: event-log entry "cleanup_completed" with code local_leave.
    const logNodes = Array.from(getByTestId("event-log").children);
    const codes = logNodes.map(
      (li) => (li as HTMLElement).getAttribute("data-code") ?? "",
    );
    expect(codes).toContain("local_leave");
  });

  it("Path A step order — local tracks stopped BEFORE pc.close (§C.5 contract)", async () => {
    // This is the subtle ordering §C.5 pins. The regression this test
    // catches: swapping 1 and 3 (or 4) so the remote side sees an
    // ICE-disconnect flap instead of a graceful track-ended event.
    const callOrder: string[] = [];
    const harness = makeHarness({ hasPeerConnection: true });
    harness.localMediaRelease.mockImplementation(() => {
      callOrder.push("release");
      for (const t of harness.tracks) t.stop();
    });
    harness.teardownPeerConnection.mockImplementation(() => {
      callOrder.push("teardown");
    });
    let api: ReturnType<typeof useCleanup> | null = null;
    renderHarness({
      harness,
      initialState: connectedRootState(),
      children: createElement(CleanupExposer, {
        onReady: (v) => {
          api = v;
        },
      }),
    });
    await act(async () => {
      await api!.leaveSession();
    });
    expect(callOrder.indexOf("release")).toBeLessThan(
      callOrder.indexOf("teardown"),
    );
  });

  it("calls screen-share stop BEFORE pc.close when screen share is active", async () => {
    // Phase 11's controller.stop("app") does a final
    // replaceTrack(null) on the video sender; that call MUST land
    // before pc.close() or the screen track orphans.
    const callOrder: string[] = [];
    const harness = makeHarness({
      hasPeerConnection: true,
      screenShareActive: true,
    });
    harness.screenShareStop.mockImplementation(async () => {
      callOrder.push("screen-share-stop");
    });
    harness.teardownPeerConnection.mockImplementation(() => {
      callOrder.push("teardown");
    });
    let api: ReturnType<typeof useCleanup> | null = null;
    renderHarness({
      harness,
      initialState: connectedRootState(),
      children: createElement(CleanupExposer, {
        onReady: (v) => {
          api = v;
        },
      }),
    });
    await act(async () => {
      await api!.leaveSession();
    });
    expect(harness.screenShareStop).toHaveBeenCalledWith("app");
    expect(callOrder.indexOf("screen-share-stop")).toBeLessThan(
      callOrder.indexOf("teardown"),
    );
  });
});

// ---------------------------------------------------------------------
// Path B — remote peer_left (local stays put)
// ---------------------------------------------------------------------

describe("Path B — remote peer_left", () => {
  it("closes DC+PC + clears remote state, KEEPS local tracks live, transitions to waiting-for-peer", async () => {
    const harness = makeHarness({ hasPeerConnection: true });
    const { getByTestId } = renderHarness({
      harness,
      initialState: connectedRootState(),
      children: createElement(
        "div",
        null,
        createElement(SessionProbe),
        createElement(EventLogProbe),
      ),
    });

    act(() => {
      harness.client._pushInbound({
        v: CONTRACT_VERSION,
        type: "peer_left",
        roomId: "demo",
        payload: {
          peerId: "aaaa2222-bbbb-cccc-dddd-eeeeffff0000",
          reason: "graceful_leave",
        },
      });
    });

    // PC teardown called with source "remote_peer_left".
    expect(harness.teardownPeerConnection).toHaveBeenCalledTimes(1);
    expect(harness.teardownPeerConnection.mock.calls[0][0]).toBe(
      "remote_peer_left",
    );

    // Local tracks STAY LIVE — FR-005 split + §C.5 Path B invariant.
    // This is the "local camera off when remote hangs up" regression
    // guard.
    expect(harness.localMediaRelease).not.toHaveBeenCalled();
    expect(harness.tracks.every((t) => t.readyState === "live")).toBe(true);

    // WS stays open.
    expect(harness.client.close).not.toHaveBeenCalled();

    // Reducer → waiting-for-peer.
    expect(getByTestId("probe-session").textContent).toBe(
      "waiting-for-peer",
    );

    // Event log code remote_peer_left.
    const logNodes = Array.from(getByTestId("event-log").children);
    const codes = logNodes.map(
      (li) => (li as HTMLElement).getAttribute("data-code") ?? "",
    );
    expect(codes).toContain("remote_peer_left");
  });
});

// ---------------------------------------------------------------------
// T083 — pending-media release MUST NOT invoke Path B
// ---------------------------------------------------------------------

describe("T083 — pending-media release does not invoke Path B", () => {
  it("peer_presence_changed(presence=released) does NOT call teardownPeerConnection", () => {
    // Harness has NO active PC (pending-media has never seen
    // ready_for_offer). Server emits
    // peer_presence_changed(presence=released) alone (contract §3.13);
    // peer_left is reserved for in-call departures (§3.12).
    const harness = makeHarness({ hasPeerConnection: false });
    const { getByTestId } = renderHarness({
      harness,
      initialState: pendingMediaRootState(),
      children: createElement(
        "div",
        null,
        createElement(SessionProbe),
        createElement(EventLogProbe),
      ),
    });

    act(() => {
      harness.client._pushInbound({
        v: CONTRACT_VERSION,
        type: "peer_presence_changed",
        roomId: "demo",
        payload: {
          subjectPeerId: "aaaa2222-bbbb-cccc-dddd-eeeeffff0000",
          admissionOrder: 2,
          presence: "released",
          reason: "media_failed",
        },
      });
    });

    // Path B guard — no teardown call, no Path B reducer action.
    expect(harness.teardownPeerConnection).not.toHaveBeenCalled();
    // Session stays at pending-media (Path B would have transitioned
    // us, but waiting-for-peer would also be illegal from pending-
    // media; the real guard is that remotePeerLeft never ran).
    expect(getByTestId("probe-session").textContent).toBe("pending-media");
  });

  it("server bug — if peer_left arrives with no active PC, Path B is refused with an error log", () => {
    // Defensive second layer. Even if the server (erroneously) emits
    // peer_left during pending-media, the client must refuse to run
    // Path B against a non-existent PC. Assertion: teardown NOT
    // called; reducer unchanged.
    const harness = makeHarness({ hasPeerConnection: false });
    const { getByTestId } = renderHarness({
      harness,
      initialState: pendingMediaRootState(),
      children: createElement(
        "div",
        null,
        createElement(SessionProbe),
        createElement(EventLogProbe),
      ),
    });
    act(() => {
      harness.client._pushInbound({
        v: CONTRACT_VERSION,
        type: "peer_left",
        roomId: "demo",
        payload: {
          peerId: "aaaa2222-bbbb-cccc-dddd-eeeeffff0000",
          reason: "disconnect",
        },
      });
    });
    expect(harness.teardownPeerConnection).not.toHaveBeenCalled();
    expect(getByTestId("probe-session").textContent).toBe("pending-media");
    const logNodes = Array.from(getByTestId("event-log").children);
    const types = logNodes.map(
      (li) => (li as HTMLElement).getAttribute("data-type") ?? "",
    );
    expect(types).toContain("error_occurred");
  });
});

// ---------------------------------------------------------------------
// Path C — terminal failure + FailurePanel + Leave / Rejoin
// ---------------------------------------------------------------------

describe("Path C — ICE / fatal PC failure", () => {
  it("renders Leave + Rejoin; local tracks remain live until user clicks", async () => {
    const harness = makeHarness({ hasPeerConnection: false });
    // Start from `failed` state (the PC-provider would have dispatched
    // CONNECTION_FAILED on connectionState="failed"; we test the UI
    // half here).
    const { getByTestId, queryByTestId } = renderHarness({
      harness,
      initialState: failedRootState(),
      children: createElement(
        "div",
        null,
        createElement(SessionProbe),
        createElement(FailurePanel),
      ),
    });

    expect(getByTestId("probe-session").textContent).toBe("failed");
    expect(queryByTestId("failure-panel-leave")).not.toBeNull();
    expect(queryByTestId("failure-panel-rejoin")).not.toBeNull();

    // Local tracks are STILL live until the user chooses an action.
    expect(harness.tracks.every((t) => t.readyState === "live")).toBe(true);
    expect(harness.localMediaRelease).not.toHaveBeenCalled();
  });

  it("Leave button runs Path A → session idle + local tracks stopped", async () => {
    const harness = makeHarness({ hasPeerConnection: false });
    const { getByTestId } = renderHarness({
      harness,
      initialState: failedRootState(),
      children: createElement(
        "div",
        null,
        createElement(SessionProbe),
        createElement(FailurePanel),
      ),
    });
    await act(async () => {
      fireEvent.click(getByTestId("failure-panel-leave"));
    });
    // After the click+await, Path A should have run.
    expect(harness.localMediaRelease).toHaveBeenCalledTimes(1);
    expect(harness.tracks.every((t) => t.readyState === "ended")).toBe(true);
    expect(getByTestId("probe-session").textContent).toBe("idle");
  });

  it("Rejoin button runs Path A then re-enters joining with the prior room id", async () => {
    const harness = makeHarness({ hasPeerConnection: false });
    const { getByTestId } = renderHarness({
      harness,
      initialState: failedRootState(),
      children: createElement(
        "div",
        null,
        createElement(SessionProbe),
        createElement(FailurePanel),
      ),
    });
    await act(async () => {
      fireEvent.click(getByTestId("failure-panel-rejoin"));
    });
    // Rejoin is an alias for Leave + fresh Join — Path A must run:
    expect(harness.localMediaRelease).toHaveBeenCalledTimes(1);
    expect(harness.client.close).toHaveBeenCalled();
    // …then the normal Join flow re-enters on the prior room id.
    expect(harness.client.connect).toHaveBeenCalled();
    const joinCalls = harness.client.send.mock.calls
      .map((c) => c[0] as { type: string; roomId: string })
      .filter((m) => m.type === "join_room");
    expect(joinCalls.length).toBe(1);
    expect(joinCalls[0].roomId).toBe("demo");
    // Reducer moves idle → joining.
    expect(getByTestId("probe-session").textContent).toBe("joining");
  });
});

// ---------------------------------------------------------------------
// T084 — signaling-disconnect branching (§B.1.1)
// ---------------------------------------------------------------------

describe("T084 — signaling-disconnect branching", () => {
  it("pre-connected (connecting) + transport error → session = failed", () => {
    const harness = makeHarness({ hasPeerConnection: true });
    const { getByTestId } = renderHarness({
      harness,
      initialState: connectingRootState(),
      children: createElement(SessionProbe),
    });

    act(() => {
      harness.client._pushTransport("error");
    });

    expect(getByTestId("probe-session").textContent).toBe("failed");
    expect(harness.teardownPeerConnection).toHaveBeenCalledTimes(1);
    expect(harness.teardownPeerConnection.mock.calls[0][0]).toBe(
      "local_failure",
    );
    // Local tracks are NOT released pre-click (same policy as ICE
    // failure: the FailurePanel owns the explicit "stop tracks" step).
    expect(harness.localMediaRelease).not.toHaveBeenCalled();
  });

  it("connected + transport error → transport=error, session stays connected (teachable moment)", () => {
    const harness = makeHarness({ hasPeerConnection: true });
    const { getByTestId } = renderHarness({
      harness,
      initialState: connectedRootState(),
      children: createElement(SessionProbe),
    });

    act(() => {
      harness.client._pushTransport("error");
    });

    // SessionState stays connected — media keeps flowing P2P.
    expect(getByTestId("probe-session").textContent).toBe("connected");
    // Transport slice reports error.
    expect(getByTestId("probe-transport").textContent).toBe("error");
    // PC is NOT torn down in this branch.
    expect(harness.teardownPeerConnection).not.toHaveBeenCalled();
    // Local tracks are NOT released.
    expect(harness.localMediaRelease).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------
// TestIceFailureEntersFailed — integrates the reducer with FailurePanel
// so a CONNECTION_FAILED dispatch (what PC provider emits on
// connectionState="failed") lands the UI in a visible failed state.
// ---------------------------------------------------------------------

describe("TestIceFailureEntersFailed", () => {
  it("CONNECTION_FAILED dispatch from connected → session failed + FailurePanel visible", () => {
    const harness = makeHarness({ hasPeerConnection: true });
    const DispatchExposer = ({
      onReady,
    }: {
      onReady: (d: ReturnType<typeof useDispatch>) => void;
    }) => {
      const d = useDispatch();
      useEffect(() => {
        onReady(d);
      }, [d, onReady]);
      return null;
    };
    let dispatch: ReturnType<typeof useDispatch> | null = null;
    const { getByTestId, queryByTestId } = renderHarness({
      harness,
      initialState: connectedRootState(),
      children: createElement(
        "div",
        null,
        createElement(SessionProbe),
        createElement(FailurePanel),
        createElement(DispatchExposer, {
          onReady: (d) => {
            dispatch = d;
          },
        }),
      ),
    });
    expect(queryByTestId("failure-panel-leave")).toBeNull();
    act(() => {
      dispatch!({ type: "CONNECTION_FAILED" });
    });
    expect(getByTestId("probe-session").textContent).toBe("failed");
    expect(queryByTestId("failure-panel-leave")).not.toBeNull();
    // Local tracks still live (FailurePanel contract — released only
    // when the user chooses Leave or Rejoin).
    expect(harness.tracks.every((t) => t.readyState === "live")).toBe(true);
  });
});
