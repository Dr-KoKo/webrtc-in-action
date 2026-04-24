// Signaling dispatcher contract tests (T043).
//
// These tests pin the Phase 5 dispatcher contract:
// - Valid canonical messages produce the expected reducer action.
// - Invalid inbound messages (malformed JSON, bad `v`, unknown type,
//   failed payload validation) append an `error_occurred` event log
//   entry AND send an `error` back through the WS client, without
//   mutating reducer state.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSignalingDispatcher } from "../../src/signaling/dispatcher";
import type {
  RootAction,
  RootState,
} from "../../src/state";
import { __resetEventLogSequence } from "../../src/state/event-log";
import { rootReducer, initialRootState } from "../../src/state";
import type { SignalingClient } from "../../src/signaling/client";

const ROOM = "demo";
const SELF_ID = "11111111-1111-4111-8111-111111111111";
const REMOTE_ID = "22222222-2222-4222-8222-222222222222";
const REQ_ID = "33333333-3333-4333-8333-333333333333";

function makeHarness() {
  const actions: RootAction[] = [];
  let state: RootState = initialRootState;
  const dispatch = (action: RootAction) => {
    actions.push(action);
    state = rootReducer(state, action);
  };
  const send = vi.fn();
  const close = vi.fn();
  const client: Pick<SignalingClient, "send" | "close"> = { send, close };
  const handleInbound = createSignalingDispatcher({ dispatch, client });
  return {
    handleInbound,
    send,
    close,
    getState: () => state,
    getActions: () => actions,
  };
}

describe("signaling dispatcher", () => {
  beforeEach(() => {
    __resetEventLogSequence();
  });

  it("valid join_accepted dispatches JOIN_ACCEPTED + room_joined event", () => {
    // Bring session to joining before the inbound join_accepted arrives.
    let state: RootState = rootReducer(initialRootState, {
      type: "JOIN_REQUESTED",
      roomId: ROOM,
    });
    const recorded: RootAction[] = [];
    const send = vi.fn();
    const close = vi.fn();
    const handleInbound = createSignalingDispatcher({
      dispatch: (a) => {
        recorded.push(a);
        state = rootReducer(state, a);
      },
      client: { send, close },
    });

    handleInbound(
      JSON.stringify({
        v: 1,
        type: "join_accepted",
        roomId: ROOM,
        requestId: REQ_ID,
        payload: {
          peerId: SELF_ID,
          admissionOrder: 1,
          roomReadiness: "waiting_for_media",
          remotePeer: null,
        },
      }),
    );

    expect(recorded.some((a) => a.type === "JOIN_ACCEPTED")).toBe(true);
    expect(state.session.session).toBe("pending-media");
    expect(state.session.selfPeerId).toBe(SELF_ID);
    expect(
      state.eventLog.entries.some((e) => e.type === "room_joined"),
    ).toBe(true);
    expect(send).not.toHaveBeenCalled();
    // join_accepted should NOT close the WS (close is reserved for
    // join_rejected under §3.3).
    expect(close).not.toHaveBeenCalled();
  });

  it("valid join_rejected dispatches JOIN_REJECTED + error_occurred event + closes WS", () => {
    // Setup joining state.
    let state: RootState = rootReducer(initialRootState, {
      type: "JOIN_REQUESTED",
      roomId: ROOM,
    });
    const recorded: RootAction[] = [];
    const send = vi.fn();
    const close = vi.fn();
    const handleInbound = createSignalingDispatcher({
      dispatch: (a) => {
        recorded.push(a);
        state = rootReducer(state, a);
      },
      client: { send, close },
    });
    handleInbound(
      JSON.stringify({
        v: 1,
        type: "join_rejected",
        roomId: ROOM,
        requestId: REQ_ID,
        payload: {
          result: "join_rejected_room_full",
          reason: "room_full",
          message: "Room full.",
        },
      }),
    );
    expect(recorded.some((a) => a.type === "JOIN_REJECTED")).toBe(true);
    expect(state.session.session).toBe("idle");
    expect(state.session.joinError?.result).toBe("join_rejected_room_full");
    expect(
      state.eventLog.entries.some(
        (e) =>
          e.type === "error_occurred" && e.code === "join_rejected_room_full",
      ),
    ).toBe(true);
    expect(send).not.toHaveBeenCalled();
    // Contract §3.3: close the WS on join_rejected receipt.
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("valid peer_presence_changed dispatches PEER_PRESENCE_CHANGED", () => {
    let state: RootState = initialRootState;
    const recorded: RootAction[] = [];
    const send = vi.fn();
    const close = vi.fn();
    const handleInbound = createSignalingDispatcher({
      dispatch: (a) => {
        recorded.push(a);
        state = rootReducer(state, a);
      },
      client: { send, close },
    });
    handleInbound(
      JSON.stringify({
        v: 1,
        type: "peer_presence_changed",
        roomId: ROOM,
        payload: {
          subjectPeerId: REMOTE_ID,
          admissionOrder: 2,
          presence: "pending-media",
          reason: "admitted",
        },
      }),
    );
    expect(
      recorded.some((a) => a.type === "PEER_PRESENCE_CHANGED"),
    ).toBe(true);
    expect(state.session.remoteParticipant?.peerId).toBe(REMOTE_ID);
    expect(send).not.toHaveBeenCalled();
  });

  it("unsupported `v` creates error_occurred + sends error back", () => {
    const h = makeHarness();
    h.handleInbound(
      JSON.stringify({
        v: 2,
        type: "peer_presence_changed",
        roomId: ROOM,
        payload: {
          subjectPeerId: REMOTE_ID,
          admissionOrder: 2,
          presence: "pending-media",
          reason: "admitted",
        },
      }),
    );
    const log = h.getState().eventLog.entries;
    expect(
      log.some(
        (e) => e.type === "error_occurred" && e.code === "unsupported_version",
      ),
    ).toBe(true);
    expect(h.send).toHaveBeenCalledTimes(1);
    const sent = h.send.mock.calls[0][0];
    expect(sent.type).toBe("error");
    expect(sent.payload.code).toBe("unsupported_version");
    // no state mutation
    expect(h.getState().session).toStrictEqual(initialRootState.session);
  });

  it("malformed JSON creates error_occurred + sends error back", () => {
    const h = makeHarness();
    h.handleInbound("not-json");
    const log = h.getState().eventLog.entries;
    expect(
      log.some(
        (e) => e.type === "error_occurred" && e.code === "malformed",
      ),
    ).toBe(true);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send.mock.calls[0][0].payload.code).toBe("malformed");
    expect(h.getState().session).toStrictEqual(initialRootState.session);
  });

  it("unknown type creates error_occurred + sends error back", () => {
    const h = makeHarness();
    h.handleInbound(
      JSON.stringify({
        v: 1,
        type: "definitely_not_a_real_type",
        roomId: ROOM,
        payload: {},
      }),
    );
    const log = h.getState().eventLog.entries;
    expect(
      log.some(
        (e) => e.type === "error_occurred" && e.code === "malformed",
      ),
    ).toBe(true);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.getState().session).toStrictEqual(initialRootState.session);
  });

  it("payload validation failure does not mutate session state", () => {
    // `join_accepted` missing required payload fields.
    let state: RootState = rootReducer(initialRootState, {
      type: "JOIN_REQUESTED",
      roomId: ROOM,
    });
    const before = state.session;
    const recorded: RootAction[] = [];
    const send = vi.fn();
    const close = vi.fn();
    const handleInbound = createSignalingDispatcher({
      dispatch: (a) => {
        recorded.push(a);
        state = rootReducer(state, a);
      },
      client: { send, close },
    });
    handleInbound(
      JSON.stringify({
        v: 1,
        type: "join_accepted",
        roomId: ROOM,
        requestId: REQ_ID,
        payload: {
          // missing peerId, admissionOrder, etc.
        },
      }),
    );
    // Session slice must be unchanged (still joining).
    expect(state.session).toStrictEqual(before);
    // No JOIN_ACCEPTED dispatched
    expect(recorded.some((a) => a.type === "JOIN_ACCEPTED")).toBe(false);
    // error_occurred appended
    expect(
      state.eventLog.entries.some((e) => e.type === "error_occurred"),
    ).toBe(true);
    // error sent upstream
    expect(send).toHaveBeenCalled();
  });

  it("inbound media_state updates the remote slice + logs one remote entry", () => {
    const h = makeHarness();
    h.handleInbound(
      JSON.stringify({
        v: 1,
        type: "media_state",
        roomId: ROOM,
        payload: {
          microphone: "off",
          camera: "on",
          screenShare: "inactive",
        },
      }),
    );
    expect(h.getState().media.remote).toEqual({
      microphone: "off",
      camera: "on",
      screenShare: "inactive",
    });
    const mediaEntries = h
      .getState()
      .eventLog.entries.filter((e) => e.type === "media_state");
    expect(mediaEntries).toHaveLength(1);
    expect(mediaEntries[0].direction).toBe("remote");
    expect(h.send).not.toHaveBeenCalled();
  });

  it("peer_presence_changed(left) clears the remote media slice", () => {
    const h = makeHarness();
    // Seed a remote media_state so the slice has a triplet to clear.
    h.handleInbound(
      JSON.stringify({
        v: 1,
        type: "media_state",
        roomId: ROOM,
        payload: {
          microphone: "off",
          camera: "on",
          screenShare: "inactive",
        },
      }),
    );
    expect(h.getState().media.remote).not.toBeNull();

    h.handleInbound(
      JSON.stringify({
        v: 1,
        type: "peer_presence_changed",
        roomId: ROOM,
        payload: {
          subjectPeerId: REMOTE_ID,
          admissionOrder: 2,
          presence: "left",
          reason: "graceful_leave",
        },
      }),
    );
    expect(h.getState().media.remote).toBeNull();
  });

  it("peer_presence_changed(released) clears the remote media slice", () => {
    const h = makeHarness();
    h.handleInbound(
      JSON.stringify({
        v: 1,
        type: "media_state",
        roomId: ROOM,
        payload: {
          microphone: "on",
          camera: "off",
          screenShare: "inactive",
        },
      }),
    );
    expect(h.getState().media.remote).not.toBeNull();

    h.handleInbound(
      JSON.stringify({
        v: 1,
        type: "peer_presence_changed",
        roomId: ROOM,
        payload: {
          subjectPeerId: REMOTE_ID,
          admissionOrder: 2,
          presence: "released",
          reason: "disconnect",
        },
      }),
    );
    expect(h.getState().media.remote).toBeNull();
  });

  it("validation failure without a client is tolerated (no throw)", () => {
    let state: RootState = initialRootState;
    const handleInbound = createSignalingDispatcher({
      dispatch: (a) => {
        state = rootReducer(state, a);
      },
      client: null,
    });
    expect(() => handleInbound("not-json")).not.toThrow();
    expect(
      state.eventLog.entries.some((e) => e.type === "error_occurred"),
    ).toBe(true);
  });
});
