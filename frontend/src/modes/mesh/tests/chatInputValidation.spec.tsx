// T064 — chat input validation surface (FR-054, NFR-006).
//
// Asserts:
//   - Empty / whitespace-only input is rejected at submit.
//   - 501-char input is rejected; 500-char input is accepted.
//   - HTML-like text is rendered as text, never as HTML
//     (`dangerouslySetInnerHTML` is never used).
//   - Rejected input does NOT call `dc.send`.

import { useEffect } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { MeshStoreProvider, useMeshDispatch } from "../state";
import { MeshChat } from "../components/MeshChat";
import type {
  MeshChatSendablePairView,
  MeshPairManager,
} from "../webrtc/pairManager";

// ---- shared fakes -------------------------------------------------------

class TrackingChannel {
  public readyState: RTCDataChannelState = "open";
  public readonly sent: string[] = [];
  send(data: string) {
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

// Test harness — mocks the pair-manager context so MeshChat can read
// the manager directly without going through MeshSignalingProvider.
vi.mock("../signaling/provider", () => {
  return {
    useMeshPairManager: () => globalPairManager,
  };
});

let globalPairManager: MeshPairManager | null = null;

function PrimeLocal({ peerId, roomId }: { peerId: string; roomId: string }) {
  const dispatch = useMeshDispatch();
  // Drive the local FSM into `media-ready` once so the Send button
  // enables. Dispatching in the render body would loop forever.
  useEffect(() => {
    dispatch({ type: "MESH_JOIN_REQUESTED", roomId });
    dispatch({ type: "MESH_JOIN_ACCEPTED", peerId, admissionIndex: 1 });
    dispatch({ type: "MESH_MEDIA_ACQUIRE_STARTED" });
    dispatch({ type: "MESH_MEDIA_READY" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

function renderChat(pairs: MeshChatSendablePairView[]) {
  globalPairManager = makePairManager(pairs);
  return render(
    <MeshStoreProvider>
      <PrimeLocal peerId="self-peer" roomId="demo" />
      <MeshChat />
    </MeshStoreProvider>,
  );
}

beforeEach(() => {
  cleanup();
  globalPairManager = null;
});

describe("MeshChat input validation", () => {
  it("rejects empty input at submit; no dc.send", () => {
    const dc = new TrackingChannel();
    renderChat([{ pairId: "1-2", remotePeerId: "peer-b", dc: dc as unknown as RTCDataChannel }]);
    fireEvent.submit(screen.getByTestId("mesh-chat-form"));
    expect(dc.sent).toHaveLength(0);
    expect(screen.getByTestId("mesh-chat-validation-error").dataset.reason).toBe("empty");
  });

  it("rejects whitespace-only input", () => {
    const dc = new TrackingChannel();
    renderChat([{ pairId: "1-2", remotePeerId: "peer-b", dc: dc as unknown as RTCDataChannel }]);
    fireEvent.change(screen.getByTestId("mesh-chat-input"), { target: { value: "   \n\t  " } });
    fireEvent.submit(screen.getByTestId("mesh-chat-form"));
    expect(dc.sent).toHaveLength(0);
    expect(screen.getByTestId("mesh-chat-validation-error").dataset.reason).toBe("empty");
  });

  it("rejects 501-character message", () => {
    const dc = new TrackingChannel();
    renderChat([{ pairId: "1-2", remotePeerId: "peer-b", dc: dc as unknown as RTCDataChannel }]);
    fireEvent.change(screen.getByTestId("mesh-chat-input"), {
      target: { value: "a".repeat(501) },
    });
    fireEvent.submit(screen.getByTestId("mesh-chat-form"));
    expect(dc.sent).toHaveLength(0);
    expect(screen.getByTestId("mesh-chat-validation-error").dataset.reason).toBe("too_long");
  });

  it("accepts 500-character message", () => {
    const dc = new TrackingChannel();
    renderChat([{ pairId: "1-2", remotePeerId: "peer-b", dc: dc as unknown as RTCDataChannel }]);
    fireEvent.change(screen.getByTestId("mesh-chat-input"), {
      target: { value: "a".repeat(500) },
    });
    fireEvent.submit(screen.getByTestId("mesh-chat-form"));
    expect(dc.sent).toHaveLength(1);
    expect(screen.queryByTestId("mesh-chat-validation-error")).toBeNull();
  });

  it("renders HTML-like text as text, never as HTML", () => {
    const dc = new TrackingChannel();
    renderChat([{ pairId: "1-2", remotePeerId: "peer-b", dc: dc as unknown as RTCDataChannel }]);
    fireEvent.change(screen.getByTestId("mesh-chat-input"), {
      target: { value: "<b>hi</b><script>alert(1)</script>" },
    });
    fireEvent.submit(screen.getByTestId("mesh-chat-form"));
    const textNode = screen.getByTestId("mesh-chat-message-text");
    expect(textNode.querySelector("b")).toBeNull();
    expect(textNode.querySelector("script")).toBeNull();
    expect(textNode.textContent).toBe("<b>hi</b><script>alert(1)</script>");
    // Whatever was on the wire must still be the literal trimmed string.
    const sentPayload = JSON.parse(dc.sent[0]);
    expect(sentPayload.text).toBe("<b>hi</b><script>alert(1)</script>");
  });

  it("does not use dangerouslySetInnerHTML on the message text", () => {
    const dc = new TrackingChannel();
    renderChat([{ pairId: "1-2", remotePeerId: "peer-b", dc: dc as unknown as RTCDataChannel }]);
    fireEvent.change(screen.getByTestId("mesh-chat-input"), {
      target: { value: "hello" },
    });
    fireEvent.submit(screen.getByTestId("mesh-chat-form"));
    const messages = screen.getByTestId("mesh-chat-messages");
    // dangerouslySetInnerHTML would surface as an element with raw
    // HTML siblings; we render via React text children which appear
    // as a Text node inside the `mesh-chat-message-text` <p>.
    const text = within(messages).getByTestId("mesh-chat-message-text");
    expect(text.children.length).toBe(0);
    expect(text.firstChild?.nodeType).toBe(3 /* Node.TEXT_NODE */);
  });
});
