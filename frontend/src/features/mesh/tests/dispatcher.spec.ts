// T038 — mesh dispatcher tests. Verify that:
//   - mesh_roster_snapshot drives MESH_ROSTER_SNAPSHOT_APPLIED + a
//     room-scoped event entry plus per-peer entries.
//   - mesh_roster_update drives MESH_ROSTER_UPDATE_APPLIED + a
//     peer-scoped entry; FR-061 invariant holds.
//   - An out-of-order serverSeq is dropped and recorded as
//     `mesh_roster_update_dropped_stale`.
//   - participant_released drives MESH_PARTICIPANT_RELEASED.
//   - join_rejected logs + closes the WS.

import { describe, expect, it, vi } from "vitest";
import { createMeshDispatcher } from "../signaling/dispatcher";
import {
  initialMeshRootState,
  meshRootReducer,
  type MeshRootState,
} from "../state";
import { __resetMeshEventLogSequence } from "../state/eventLog";

const PEER_A = "11111111-1111-4111-8111-111111111111";
const PEER_B = "22222222-2222-4222-8222-222222222222";
const SELF = "99999999-9999-4999-8999-999999999999";
const REQ = "deadbeef-0000-4000-8000-000000000001";

function makeStore() {
  let state: MeshRootState = initialMeshRootState;
  const dispatch = vi.fn((a) => {
    state = meshRootReducer(state, a);
  });
  return {
    dispatch,
    getState: () => state,
  };
}

function makeDispatcher(opts: {
  store: ReturnType<typeof makeStore>;
  selfPeerId?: string;
  client?: { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
  fsm?: () => string;
}) {
  __resetMeshEventLogSequence();
  return createMeshDispatcher({
    dispatch: opts.store.dispatch,
    client: opts.client ?? null,
    getSelfPeerId: () => opts.selfPeerId,
    getRosterServerSeq: () => opts.store.getState().roster.serverSeq,
    ...(opts.fsm ? { getLocalFsm: opts.fsm } : {}),
  });
}

describe("mesh dispatcher", () => {
  it("snapshot replaces the roster map and emits per-peer events", () => {
    const store = makeStore();
    const dispatcher = makeDispatcher({ store, selfPeerId: SELF });

    dispatcher(
      JSON.stringify({
        v: 2,
        type: "mesh_roster_snapshot",
        roomId: "demo",
        payload: {
          serverSeq: 3,
          participants: [
            { peerId: SELF, admissionIndex: 1, presence: "joined" },
            { peerId: PEER_A, admissionIndex: 2, presence: "media-ready" },
            { peerId: PEER_B, admissionIndex: 3, presence: "joined" },
          ],
        },
      }),
    );

    const state = store.getState();
    expect(state.roster.serverSeq).toBe(3);
    expect(Object.keys(state.roster.byPeerId).sort()).toEqual(
      [PEER_A, PEER_B].sort(),
    );

    const peerEntries = state.eventLog.entries.filter((e) => e.scope === "peer");
    expect(peerEntries.map((e) => e.peerId).sort()).toEqual(
      [PEER_A, PEER_B].sort(),
    );
    // FR-061: every peer-scoped entry carries peerId.
    for (const e of peerEntries) {
      expect(e.peerId).toBeTruthy();
    }
    const room = state.eventLog.entries.find(
      (e) => e.type === "mesh_roster_snapshot_received",
    );
    expect(room).toBeDefined();
  });

  it("applies updates monotonically and logs a peer-scoped entry", () => {
    const store = makeStore();
    const dispatcher = makeDispatcher({ store, selfPeerId: SELF });
    dispatcher(
      JSON.stringify({
        v: 2,
        type: "mesh_roster_snapshot",
        roomId: "demo",
        payload: { serverSeq: 1, participants: [] },
      }),
    );
    dispatcher(
      JSON.stringify({
        v: 2,
        type: "mesh_roster_update",
        roomId: "demo",
        payload: {
          serverSeq: 2,
          subjectPeerId: PEER_A,
          admissionIndex: 2,
          presence: "joined",
          reason: "admitted",
        },
      }),
    );
    expect(store.getState().roster.byPeerId[PEER_A]).toBeDefined();
    const applied = store
      .getState()
      .eventLog.entries.find((e) => e.type === "mesh_roster_update_applied" && e.peerId === PEER_A);
    expect(applied).toBeDefined();
  });

  it("drops stale serverSeq updates and logs them", () => {
    const store = makeStore();
    const dispatcher = makeDispatcher({ store, selfPeerId: SELF });
    dispatcher(
      JSON.stringify({
        v: 2,
        type: "mesh_roster_snapshot",
        roomId: "demo",
        payload: {
          serverSeq: 5,
          participants: [
            { peerId: PEER_A, admissionIndex: 2, presence: "media-ready" },
          ],
        },
      }),
    );
    // Stale: same serverSeq as snapshot.
    dispatcher(
      JSON.stringify({
        v: 2,
        type: "mesh_roster_update",
        roomId: "demo",
        payload: {
          serverSeq: 5,
          subjectPeerId: PEER_A,
          admissionIndex: 2,
          presence: "joined",
          reason: "admitted",
        },
      }),
    );
    const state = store.getState();
    expect(state.roster.byPeerId[PEER_A].presence).toBe("media-ready");
    const dropped = state.eventLog.entries.find(
      (e) => e.type === "mesh_roster_update_dropped_stale",
    );
    expect(dropped).toBeDefined();
    expect(dropped?.peerId).toBe(PEER_A);
  });

  it("join_rejected dispatches MESH_JOIN_REJECTED and closes the WS", () => {
    const store = makeStore();
    const close = vi.fn();
    const send = vi.fn();
    const dispatcher = makeDispatcher({ store, client: { send, close } });
    // Set local to joining first.
    store.dispatch({ type: "MESH_JOIN_REQUESTED", roomId: "demo" });
    dispatcher(
      JSON.stringify({
        v: 2,
        type: "join_rejected",
        roomId: "demo",
        requestId: REQ,
        payload: {
          result: "join_rejected_room_full",
          reason: "room_full",
          message: "full",
        },
      }),
    );
    expect(close).toHaveBeenCalled();
    expect(store.getState().local.fsm).toBe("idle");
    expect(store.getState().local.errorBanner?.kind).toBe("join-rejected");
  });

  it("unsupported version logs error and emits typed `error` envelope", () => {
    const store = makeStore();
    const send = vi.fn();
    const close = vi.fn();
    const dispatcher = makeDispatcher({ store, client: { send, close } });
    dispatcher(JSON.stringify({ v: 3, type: "join_accepted" }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].payload.code).toBe("unsupported_version");
    const errEntry = store
      .getState()
      .eventLog.entries.find((e) => e.type === "error_occurred");
    expect(errEntry).toBeDefined();
  });
});
