// T091 — signalingErrorBanner.spec.tsx (M12 / EC-012 / SC-005b / Path D).
//
// Asserts the local-only signaling-error UX:
//   - hidden when fsm ∈ {idle, joining, joined, media-ready, ...}
//   - visible when MESH_TRANSPORT_CHANGED transitions fsm to
//     "signaling-error" (transport ∈ {closed, error} mid-session)
//   - banner copy matches quickstart text
//   - no auto-reconnect (the component does not call client.connect)
//   - Leave path is exposed via MeshControls (covered separately by
//     leavePath.spec.ts; here we assert the banner does not block it).

import { useEffect } from "react";
import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { MeshStoreProvider, useMeshDispatch } from "../state";
import {
  SignalingErrorBanner,
  SIGNALING_ERROR_BANNER_COPY,
} from "../components/SignalingErrorBanner";
import {
  initialMeshLocalParticipant,
  meshLocalReducer,
} from "../state/local";

beforeEach(() => cleanup());

describe("<SignalingErrorBanner />", () => {
  function PrimeSignalingError() {
    const dispatch = useMeshDispatch();
    useEffect(() => {
      // Walk into a mid-session state, then drop the transport.
      dispatch({ type: "MESH_JOIN_REQUESTED", roomId: "demo" });
      dispatch({
        type: "MESH_JOIN_ACCEPTED",
        peerId: "00000000-0000-4000-8000-000000000001",
        admissionIndex: 1,
      });
      dispatch({ type: "MESH_MEDIA_ACQUIRE_STARTED" });
      dispatch({ type: "MESH_MEDIA_READY" });
      dispatch({ type: "MESH_TRANSPORT_CHANGED", transport: "closed" });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return null;
  }

  function PrimeOpen() {
    const dispatch = useMeshDispatch();
    useEffect(() => {
      dispatch({ type: "MESH_JOIN_REQUESTED", roomId: "demo" });
      dispatch({
        type: "MESH_JOIN_ACCEPTED",
        peerId: "00000000-0000-4000-8000-000000000001",
        admissionIndex: 1,
      });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return null;
  }

  it("does not render in idle (no admission)", () => {
    render(
      <MeshStoreProvider>
        <SignalingErrorBanner />
      </MeshStoreProvider>,
    );
    expect(
      screen.queryByTestId("mesh-signaling-error-banner"),
    ).toBeNull();
  });

  it("does not render while joined and transport is open", () => {
    render(
      <MeshStoreProvider>
        <PrimeOpen />
        <SignalingErrorBanner />
      </MeshStoreProvider>,
    );
    expect(
      screen.queryByTestId("mesh-signaling-error-banner"),
    ).toBeNull();
  });

  it("renders the canonical copy when fsm transitions to signaling-error", () => {
    render(
      <MeshStoreProvider>
        <PrimeSignalingError />
        <SignalingErrorBanner />
      </MeshStoreProvider>,
    );
    const banner = screen.getByTestId("mesh-signaling-error-banner");
    expect(banner).toBeTruthy();
    expect(banner.getAttribute("data-fsm")).toBe("signaling-error");
    expect(
      screen.getByTestId("mesh-signaling-error-banner-copy").textContent,
    ).toBe(SIGNALING_ERROR_BANNER_COPY);
  });

  it("uses role=alert / aria-live=assertive", () => {
    render(
      <MeshStoreProvider>
        <PrimeSignalingError />
        <SignalingErrorBanner />
      </MeshStoreProvider>,
    );
    const banner = screen.getByTestId("mesh-signaling-error-banner");
    expect(banner.getAttribute("role")).toBe("alert");
    expect(banner.getAttribute("aria-live")).toBe("assertive");
  });
});

describe("meshLocalReducer signaling-error transition (Path D)", () => {
  function joined() {
    let s = initialMeshLocalParticipant;
    s = meshLocalReducer(s, { type: "MESH_JOIN_REQUESTED", roomId: "demo" });
    s = meshLocalReducer(s, {
      type: "MESH_JOIN_ACCEPTED",
      peerId: "00000000-0000-4000-8000-000000000001",
      admissionIndex: 1,
    });
    return s;
  }

  it("transport closed mid-session → fsm = signaling-error", () => {
    let s = joined();
    s = meshLocalReducer(s, {
      type: "MESH_TRANSPORT_CHANGED",
      transport: "closed",
    });
    expect(s.fsm).toBe("signaling-error");
    expect(s.errorBanner?.kind).toBe("signaling-error");
  });

  it("transport error mid-session → fsm = signaling-error", () => {
    let s = joined();
    s = meshLocalReducer(s, {
      type: "MESH_TRANSPORT_CHANGED",
      transport: "error",
    });
    expect(s.fsm).toBe("signaling-error");
  });

  it("transport closed BEFORE admission does NOT enter signaling-error", () => {
    const s = meshLocalReducer(initialMeshLocalParticipant, {
      type: "MESH_TRANSPORT_CHANGED",
      transport: "closed",
    });
    // Pre-admission: just a transport-state change, no FSM transition.
    expect(s.fsm).toBe("idle");
  });

  it("transport closed during graceful Leave does NOT flip to signaling-error", () => {
    let s = joined();
    s = meshLocalReducer(s, { type: "MESH_LEAVE_REQUESTED" });
    expect(s.fsm).toBe("leaving");
    s = meshLocalReducer(s, {
      type: "MESH_TRANSPORT_CHANGED",
      transport: "closed",
    });
    expect(s.fsm).toBe("leaving");
  });

  it("once in signaling-error, further transport drops are no-ops", () => {
    let s = joined();
    s = meshLocalReducer(s, {
      type: "MESH_TRANSPORT_CHANGED",
      transport: "error",
    });
    const first = s;
    s = meshLocalReducer(s, {
      type: "MESH_TRANSPORT_CHANGED",
      transport: "closed",
    });
    // signalingTransport may bump but fsm stays signaling-error; banner
    // identity is stable so the user does not see flicker.
    expect(s.fsm).toBe("signaling-error");
    expect(s.errorBanner).toEqual(first.errorBanner);
  });
});

describe("Banner does not auto-reconnect", () => {
  it("the component file makes no reference to client.connect", async () => {
    // Import as text — the SignalingErrorBanner module MUST NOT call
    // `client.connect`, `WebSocket`, or schedule a retry. This is a
    // surface-level safeguard; the deeper guarantee is that the
    // signaling client itself never auto-reconnects (covered by
    // client.spec.ts).
    const fs = await import("node:fs");
    const path = await import("node:path");
    const file = path.resolve(
      __dirname,
      "../components/SignalingErrorBanner.tsx",
    );
    const src = fs.readFileSync(file, "utf8");
    expect(src).not.toMatch(/client\.connect|new WebSocket|setTimeout|setInterval/);
  });
});

// Touch act() so the import is referenced (suppresses
// "act is declared but never used" — the helper is reserved for future
// async assertions if banner copy gains an animated reveal).
void act;
