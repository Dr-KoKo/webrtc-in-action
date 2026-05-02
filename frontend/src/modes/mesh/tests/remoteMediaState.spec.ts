// M9 / T072 — inbound `pair_media_state` updates only the matching
// remote participant's `remoteMedia`. Covers:
//   - dispatcher routes the inbound envelope to the roster slice with
//     the sender peerId from `from`.
//   - the matching RemoteTile data updates (mic / camera / screen).
//   - unrelated peers' `remoteMedia` is untouched.
//   - inbound updates do NOT touch the local participant's media slice.
//   - missing / unknown sender is handled safely (no crash, no
//     mutation, peer/room-scoped error logged).
//
// Verify with:
//   npx vitest run src/modes/mesh/tests/remoteMediaState.spec.ts

import { describe, expect, it, vi } from "vitest";
import { createMeshDispatcher } from "../signaling/dispatcher";
import {
  initialMeshRootState,
  meshRootReducer,
  type MeshRootState,
} from "../state";

const PEER_A = "11111111-1111-4111-8111-111111111111";
const PEER_B = "22222222-2222-4222-8222-222222222222";
const SELF = "99999999-9999-4999-8999-999999999999";

function makeStore(initial?: MeshRootState) {
  let state: MeshRootState = initial ?? initialMeshRootState;
  const dispatch = vi.fn((a) => {
    state = meshRootReducer(state, a);
  });
  return { dispatch, getState: () => state };
}

function makeDispatcher(store: ReturnType<typeof makeStore>, selfPeerId?: string) {
  return createMeshDispatcher({
    dispatch: store.dispatch,
    client: null,
    getSelfPeerId: () => selfPeerId,
    getRosterServerSeq: () => store.getState().roster.serverSeq,
  });
}

function primeRosterWith(peers: Array<{ peerId: string; admissionIndex: number }>) {
  const store = makeStore();
  store.dispatch({
    type: "MESH_ROSTER_SNAPSHOT_APPLIED",
    serverSeq: 1,
    participants: peers.map((p) => ({
      peerId: p.peerId,
      admissionIndex: p.admissionIndex,
      presence: "media-ready" as const,
    })),
    selfPeerId: SELF,
  });
  return store;
}

describe("inbound pair_media_state — happy path", () => {
  it("updates only the sender's RemoteTile entry", () => {
    const store = primeRosterWith([
      { peerId: PEER_A, admissionIndex: 1 },
      { peerId: PEER_B, admissionIndex: 2 },
    ]);
    const dispatcher = makeDispatcher(store, SELF);

    dispatcher(
      JSON.stringify({
        v: 2,
        type: "pair_media_state",
        roomId: "demo",
        from: PEER_A,
        payload: { microphone: "off", camera: "on", screenShare: "inactive" },
      }),
    );

    const a = store.getState().roster.byPeerId[PEER_A];
    const b = store.getState().roster.byPeerId[PEER_B];
    expect(a.remoteMedia.microphone).toBe("off");
    expect(a.remoteMedia.camera).toBe("on");
    expect(a.remoteMedia.screenShare).toBe("inactive");
    // Unrelated peer must be untouched (default values).
    expect(b.remoteMedia.microphone).toBe("on");
    expect(b.remoteMedia.camera).toBe("on");
    expect(b.remoteMedia.screenShare).toBe("inactive");
  });

  it("logs a peer-scoped event identifying the signaling metadata path", () => {
    const store = primeRosterWith([{ peerId: PEER_A, admissionIndex: 1 }]);
    const dispatcher = makeDispatcher(store, SELF);
    dispatcher(
      JSON.stringify({
        v: 2,
        type: "pair_media_state",
        roomId: "demo",
        from: PEER_A,
        payload: { microphone: "off", camera: "on", screenShare: "inactive" },
      }),
    );
    const entry = store
      .getState()
      .eventLog.entries.find((e) => e.type === "mesh_media_state_received");
    expect(entry).toBeDefined();
    expect(entry?.scope).toBe("peer");
    expect(entry?.peerId).toBe(PEER_A);
    expect(entry?.detail).toMatchObject({
      transport: "signaling",
      path: "metadata",
      remotePeerId: PEER_A,
    });
  });

  it("repeated updates from the same peer overwrite prior remoteMedia", () => {
    const store = primeRosterWith([{ peerId: PEER_A, admissionIndex: 1 }]);
    const dispatcher = makeDispatcher(store, SELF);

    dispatcher(
      JSON.stringify({
        v: 2,
        type: "pair_media_state",
        roomId: "demo",
        from: PEER_A,
        payload: { microphone: "off", camera: "on", screenShare: "inactive" },
      }),
    );
    dispatcher(
      JSON.stringify({
        v: 2,
        type: "pair_media_state",
        roomId: "demo",
        from: PEER_A,
        payload: { microphone: "off", camera: "off", screenShare: "inactive" },
      }),
    );
    expect(store.getState().roster.byPeerId[PEER_A].remoteMedia.camera).toBe(
      "off",
    );
  });
});

describe("inbound pair_media_state — error handling", () => {
  it("payload missing `from` is rejected with an error event and no roster mutation", () => {
    const store = primeRosterWith([{ peerId: PEER_A, admissionIndex: 1 }]);
    const dispatcher = makeDispatcher(store, SELF);
    const before = store.getState().roster.byPeerId[PEER_A];

    dispatcher(
      JSON.stringify({
        v: 2,
        type: "pair_media_state",
        roomId: "demo",
        // no `from`
        payload: { microphone: "off", camera: "on", screenShare: "inactive" },
      }),
    );

    const after = store.getState().roster.byPeerId[PEER_A];
    expect(after.remoteMedia).toEqual(before.remoteMedia);
    const err = store
      .getState()
      .eventLog.entries.find(
        (e) =>
          e.type === "error_occurred" &&
          typeof e.summary === "string" &&
          e.summary.includes("pair_media_state received without `from`"),
      );
    expect(err).toBeDefined();
  });

  it("unknown sender (peer not in roster) is a safe no-op", () => {
    const store = primeRosterWith([{ peerId: PEER_A, admissionIndex: 1 }]);
    const dispatcher = makeDispatcher(store, SELF);
    const before = store.getState().roster.byPeerId[PEER_A];

    dispatcher(
      JSON.stringify({
        v: 2,
        type: "pair_media_state",
        roomId: "demo",
        from: PEER_B, // not in roster
        payload: { microphone: "off", camera: "on", screenShare: "inactive" },
      }),
    );

    const after = store.getState().roster.byPeerId[PEER_A];
    // No crash, no mutation of the existing peer.
    expect(after.remoteMedia).toEqual(before.remoteMedia);
    // The dispatcher still emits a peer-scoped received event because
    // routing is by `from`; the reducer drops the update silently for
    // an unknown peer (RemoteTile would render it once the matching
    // mesh_roster_update arrives).
  });

  it("self-targeted inbound (from = local peer) is dropped without touching local-media slice", () => {
    const store = primeRosterWith([{ peerId: PEER_A, admissionIndex: 1 }]);
    const dispatcher = makeDispatcher(store, SELF);
    // Capture the local-media slice (default state).
    const beforeLocalMedia = store.getState().localMedia;
    const beforeRoster = store.getState().roster;

    dispatcher(
      JSON.stringify({
        v: 2,
        type: "pair_media_state",
        roomId: "demo",
        from: SELF,
        payload: { microphone: "off", camera: "off", screenShare: "active" },
      }),
    );

    expect(store.getState().localMedia).toEqual(beforeLocalMedia);
    expect(store.getState().roster).toEqual(beforeRoster);
    const errEntry = store
      .getState()
      .eventLog.entries.find(
        (e) =>
          e.type === "error_occurred" &&
          e.scope === "local" &&
          typeof e.summary === "string" &&
          e.summary.includes("pair_media_state received with from=self"),
      );
    expect(errEntry).toBeDefined();
  });
});
