// T063 + T067 — `<MeshChat>` integration. Wires up the real reducer +
// the real fan-out helper + a stubbed pair manager so we can drive
// concrete N=2/3/4 send scenarios end-to-end.
//
// Asserts (data-model §B.5 / FR-051..FR-052a / L17):
//   - One local-echo entry on every successful send (FR-052a).
//   - At N=4 with all dc.readyState="open": 3 dc.sends, 3 sent
//     event-log entries, fan-out summary "3 / 3 delivered".
//   - At N=4 with one closed dc: 2 dc.sends, 1 skipped event-log
//     entry, fan-out summary "2 / 3 delivered".
//   - The local echo MUST appear before the per-pair sends complete
//     (it does not wait for ACK) — we do not have async send paths
//     here so the dispatch ordering proves "no wait".

import { useEffect } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { MeshStoreProvider, useMeshDispatch } from "../state";
import { MeshChat } from "../components/MeshChat";
import type {
  MeshChatSendablePairView,
  MeshPairManager,
} from "../webrtc/pairManager";

vi.mock("../signaling/provider", () => {
  return {
    useMeshPairManager: () => globalPairManager,
  };
});

let globalPairManager: MeshPairManager | null = null;

class TrackingChannel {
  public sent: string[] = [];
  constructor(public readyState: RTCDataChannelState = "open") {}
  send(data: string) {
    if (this.readyState !== "open") {
      throw new Error("dc not open");
    }
    this.sent.push(data);
  }
}

function makePairManager(pairs: MeshChatSendablePairView[]): MeshPairManager {
  return {
    handleNegotiationInstruction: vi.fn(),
    handleNewcomerInstructions: vi.fn(),
    handlePairOffer: vi.fn(),
    handlePairAnswer: vi.fn(),
    handlePairIceCandidate: vi.fn(),
    getContext: vi.fn(),
    listContexts: vi.fn(() => []),
    listChatPairs: vi.fn(() => pairs),
    snapshotContext: vi.fn(),
    closeAll: vi.fn(),
  } as unknown as MeshPairManager;
}

function PrimeLocal() {
  const dispatch = useMeshDispatch();
  useEffect(() => {
    dispatch({ type: "MESH_JOIN_REQUESTED", roomId: "demo" });
    dispatch({ type: "MESH_JOIN_ACCEPTED", peerId: "self-peer", admissionIndex: 1 });
    dispatch({ type: "MESH_MEDIA_ACQUIRE_STARTED" });
    dispatch({ type: "MESH_MEDIA_READY" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

function setup(pairs: MeshChatSendablePairView[]) {
  globalPairManager = makePairManager(pairs);
  return render(
    <MeshStoreProvider>
      <PrimeLocal />
      <MeshChat />
    </MeshStoreProvider>,
  );
}

function makePeers(n: number) {
  const dcs: TrackingChannel[] = [];
  const pairs: MeshChatSendablePairView[] = [];
  for (let i = 2; i <= n; i++) {
    const dc = new TrackingChannel("open");
    dcs.push(dc);
    pairs.push({
      pairId: `1-${i}`,
      remotePeerId: `peer-${String.fromCharCode(64 + i)}`,
      dc: dc as unknown as RTCDataChannel,
    });
  }
  return { dcs, pairs };
}

beforeEach(() => {
  cleanup();
  globalPairManager = null;
});

describe("<MeshChat> happy path", () => {
  it("local echo appears exactly once at N=2 (1 send)", () => {
    const { dcs, pairs } = makePeers(2);
    setup(pairs);
    fireEvent.change(screen.getByTestId("mesh-chat-input"), {
      target: { value: "hi 2" },
    });
    fireEvent.submit(screen.getByTestId("mesh-chat-form"));
    expect(dcs[0].sent).toHaveLength(1);
    expect(screen.getAllByTestId("mesh-chat-message")).toHaveLength(1);
    expect(
      screen.getByTestId("mesh-chat-message-fanout").textContent,
    ).toContain("1 / 1 delivered");
  });

  it("N=3 produces 2 dc.sends + 2 sent events; local echo once", () => {
    const { dcs, pairs } = makePeers(3);
    setup(pairs);
    fireEvent.change(screen.getByTestId("mesh-chat-input"), {
      target: { value: "hi 3" },
    });
    fireEvent.submit(screen.getByTestId("mesh-chat-form"));
    expect(dcs[0].sent).toHaveLength(1);
    expect(dcs[1].sent).toHaveLength(1);
    expect(screen.getAllByTestId("mesh-chat-message")).toHaveLength(1);
    expect(
      screen.getByTestId("mesh-chat-message-fanout").textContent,
    ).toContain("2 / 2 delivered");
  });

  it("N=4 produces 3 dc.sends + 3 sent events; local echo once", () => {
    const { dcs, pairs } = makePeers(4);
    setup(pairs);
    fireEvent.change(screen.getByTestId("mesh-chat-input"), {
      target: { value: "hi 4" },
    });
    fireEvent.submit(screen.getByTestId("mesh-chat-form"));
    expect(dcs[0].sent).toHaveLength(1);
    expect(dcs[1].sent).toHaveLength(1);
    expect(dcs[2].sent).toHaveLength(1);
    expect(screen.getAllByTestId("mesh-chat-message")).toHaveLength(1);
    expect(
      screen.getByTestId("mesh-chat-message-fanout").textContent,
    ).toContain("3 / 3 delivered");
  });

  it("clears the input after a successful send", () => {
    const { pairs } = makePeers(2);
    setup(pairs);
    const input = screen.getByTestId("mesh-chat-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.submit(screen.getByTestId("mesh-chat-form"));
    expect(input.value).toBe("");
  });
});

describe("<MeshChat> skipped peers", () => {
  it("at N=4 with one closed dc: 2 sends, 1 skip, 2 / 3 delivered", () => {
    const { dcs, pairs } = makePeers(4);
    dcs[1].readyState = "closed"; // peer C
    setup(pairs);
    fireEvent.change(screen.getByTestId("mesh-chat-input"), {
      target: { value: "hi" },
    });
    fireEvent.submit(screen.getByTestId("mesh-chat-form"));
    expect(dcs[0].sent).toHaveLength(1);
    expect(dcs[1].sent).toHaveLength(0);
    expect(dcs[2].sent).toHaveLength(1);
    const summary = screen.getByTestId("mesh-chat-message-fanout");
    expect(summary.textContent).toContain("2 / 3 delivered");
    expect(summary.dataset.skipped).toBe("1");
    // Skipped detail should name the closed peer.
    expect(summary.textContent).toContain("peer-C");
  });
});
