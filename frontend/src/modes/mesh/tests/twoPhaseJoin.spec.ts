// T043 — two-phase join readiness invariant tests.
//
// The mesh hard boundary for M5 is: NO `RTCPeerConnection` is created
// before the local participant reaches `media-ready`. The dispatcher
// enforces this by logging an `error_occurred` event-log entry on a
// `pair_negotiation_instruction` arriving in any non-ready state.
//
// These tests do not actually construct an `RTCPeerConnection`; they
// drive the dispatcher and assert:
//   1. The local FSM walks `joining → joined → acquiring-media → media-ready`
//      without skipping any state.
//   2. A `pair_negotiation_instruction` arriving while the local FSM
//      is `joined` (pre-media) is logged as `error_occurred` and never
//      mutates roster / pair-state slices.
//   3. The same instruction arriving while `media-ready` is logged as
//      `future_phase_message` (M6 wires the actual PC creation).

import { describe, expect, it, vi } from "vitest";
import { createMeshDispatcher } from "../signaling/dispatcher";
import {
  initialMeshRootState,
  meshRootReducer,
  type MeshRootState,
} from "../state";

const PEER_A = "11111111-1111-4111-8111-111111111111";
const SELF = "99999999-9999-4999-8999-999999999999";

function makeStore() {
  let state: MeshRootState = initialMeshRootState;
  const dispatch = vi.fn((a) => {
    state = meshRootReducer(state, a);
  });
  return { dispatch, getState: () => state };
}

function pairInstructionMessage(pairEpoch: number) {
  return JSON.stringify({
    v: 2,
    type: "pair_negotiation_instruction",
    roomId: "demo",
    to: SELF,
    payload: {
      pairId: "1-2",
      pairEpoch,
      role: "answerer",
      remotePeer: { peerId: PEER_A, admissionIndex: 1 },
      iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }],
    },
  });
}

describe("two-phase join readiness", () => {
  it("local FSM walks joining → joined → acquiring-media → media-ready", () => {
    const store = makeStore();
    store.dispatch({ type: "MESH_JOIN_REQUESTED", roomId: "demo" });
    expect(store.getState().local.fsm).toBe("joining");
    store.dispatch({
      type: "MESH_JOIN_ACCEPTED",
      peerId: SELF,
      admissionIndex: 4,
    });
    expect(store.getState().local.fsm).toBe("joined");
    store.dispatch({ type: "MESH_MEDIA_ACQUIRE_STARTED" });
    expect(store.getState().local.fsm).toBe("acquiring-media");
    store.dispatch({ type: "MESH_MEDIA_READY" });
    expect(store.getState().local.fsm).toBe("media-ready");
  });

  it("ignores pair_negotiation_instruction before media-ready (logs error_occurred)", () => {
    const store = makeStore();
    const dispatcher = createMeshDispatcher({
      dispatch: store.dispatch,
      client: null,
      getSelfPeerId: () => SELF,
      getRosterServerSeq: () => store.getState().roster.serverSeq,
      getLocalFsm: () => store.getState().local.fsm,
    });
    store.dispatch({ type: "MESH_JOIN_REQUESTED", roomId: "demo" });
    store.dispatch({
      type: "MESH_JOIN_ACCEPTED",
      peerId: SELF,
      admissionIndex: 4,
    });
    expect(store.getState().local.fsm).toBe("joined");

    dispatcher(pairInstructionMessage(1));
    const state = store.getState();
    // No PC creation slice exists in M5; what we *can* prove is that
    // no roster mutation happened, no MEDIA_READY action fired, and
    // the dispatcher logged an `error_occurred` entry on the PAIR
    // scope of the inbound message.
    expect(state.local.fsm).toBe("joined");
    expect(state.roster.serverSeq).toBe(0);
    const pairEntry = state.eventLog.entries.find(
      (e) => e.scope === "pair" && e.pairId === "1-2",
    );
    expect(pairEntry?.type).toBe("error_occurred");
    expect(pairEntry?.summary).toMatch(/before media-ready/i);
  });

  it("logs pair_negotiation_instruction as future_phase_message after media-ready", () => {
    const store = makeStore();
    const dispatcher = createMeshDispatcher({
      dispatch: store.dispatch,
      client: null,
      getSelfPeerId: () => SELF,
      getRosterServerSeq: () => store.getState().roster.serverSeq,
      getLocalFsm: () => store.getState().local.fsm,
    });
    store.dispatch({ type: "MESH_JOIN_REQUESTED", roomId: "demo" });
    store.dispatch({
      type: "MESH_JOIN_ACCEPTED",
      peerId: SELF,
      admissionIndex: 4,
    });
    store.dispatch({ type: "MESH_MEDIA_ACQUIRE_STARTED" });
    store.dispatch({ type: "MESH_MEDIA_READY" });
    expect(store.getState().local.fsm).toBe("media-ready");

    dispatcher(pairInstructionMessage(1));
    const pairEntry = store
      .getState()
      .eventLog.entries.find(
        (e) => e.scope === "pair" && e.pairId === "1-2",
      );
    expect(pairEntry?.type).toBe("future_phase_message");
  });

  it("MESH_MEDIA_READY is unreachable from `joined` without going through `acquiring-media`", () => {
    const store = makeStore();
    store.dispatch({ type: "MESH_JOIN_REQUESTED", roomId: "demo" });
    store.dispatch({
      type: "MESH_JOIN_ACCEPTED",
      peerId: SELF,
      admissionIndex: 4,
    });
    // Try to skip MEDIA_ACQUIRE_STARTED.
    store.dispatch({ type: "MESH_MEDIA_READY" });
    // Reducer guards: state stays `joined` because MESH_MEDIA_READY
    // only fires from `acquiring-media`.
    expect(store.getState().local.fsm).toBe("joined");
  });
});
