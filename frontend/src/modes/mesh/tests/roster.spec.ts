// T038 — roster reducer acceptance tests (data-model §B.2 / contract
// §3.4 / §3.5).
//
// Asserts:
//   1. mesh_roster_snapshot REPLACES the byPeerId map and updates serverSeq.
//   2. mesh_roster_update upserts a participant when serverSeq is monotonic.
//   3. Out-of-order serverSeq updates are dropped (the slice does not change).
//   4. presence ∈ {released, left} removes the participant from the roster.
//   5. The local participant is excluded from byPeerId when selfPeerId is supplied.

import { describe, expect, it } from "vitest";
import {
  initialMeshRosterSlice,
  meshRosterReducer,
  rosterReducerWithOutcome,
  selectRosterAsArray,
} from "../state/roster";

const PEER_A = "11111111-1111-4111-8111-111111111111";
const PEER_B = "22222222-2222-4222-8222-222222222222";
const PEER_C = "33333333-3333-4333-8333-333333333333";
const SELF = "99999999-9999-4999-8999-999999999999";

describe("meshRosterReducer", () => {
  it("snapshot replaces byPeerId and excludes selfPeerId", () => {
    const seeded = meshRosterReducer(initialMeshRosterSlice, {
      type: "MESH_ROSTER_SNAPSHOT_APPLIED",
      serverSeq: 1,
      participants: [
        { peerId: PEER_A, admissionIndex: 1, presence: "joined" },
      ],
    });
    expect(Object.keys(seeded.byPeerId)).toEqual([PEER_A]);

    const replaced = meshRosterReducer(seeded, {
      type: "MESH_ROSTER_SNAPSHOT_APPLIED",
      serverSeq: 7,
      participants: [
        { peerId: SELF, admissionIndex: 4, presence: "media-ready" },
        { peerId: PEER_B, admissionIndex: 2, presence: "media-ready" },
        { peerId: PEER_C, admissionIndex: 3, presence: "joined" },
      ],
      selfPeerId: SELF,
    });

    expect(replaced.serverSeq).toBe(7);
    expect(Object.keys(replaced.byPeerId).sort()).toEqual(
      [PEER_B, PEER_C].sort(),
    );
    expect(replaced.byPeerId[SELF]).toBeUndefined();
    expect(replaced.byPeerId[PEER_A]).toBeUndefined();
  });

  it("applies updates in monotonic serverSeq order", () => {
    let state = meshRosterReducer(initialMeshRosterSlice, {
      type: "MESH_ROSTER_SNAPSHOT_APPLIED",
      serverSeq: 1,
      participants: [
        { peerId: PEER_A, admissionIndex: 1, presence: "joined" },
      ],
    });
    state = meshRosterReducer(state, {
      type: "MESH_ROSTER_UPDATE_APPLIED",
      serverSeq: 2,
      subjectPeerId: PEER_A,
      admissionIndex: 1,
      presence: "media-ready",
    });
    expect(state.serverSeq).toBe(2);
    expect(state.byPeerId[PEER_A].presence).toBe("media-ready");

    state = meshRosterReducer(state, {
      type: "MESH_ROSTER_UPDATE_APPLIED",
      serverSeq: 3,
      subjectPeerId: PEER_B,
      admissionIndex: 2,
      presence: "joined",
    });
    expect(state.serverSeq).toBe(3);
    expect(selectRosterAsArray(state).map((p) => p.peerId)).toEqual([
      PEER_A,
      PEER_B,
    ]);
  });

  it("drops out-of-order serverSeq updates as stale", () => {
    let state = meshRosterReducer(initialMeshRosterSlice, {
      type: "MESH_ROSTER_SNAPSHOT_APPLIED",
      serverSeq: 5,
      participants: [
        { peerId: PEER_A, admissionIndex: 1, presence: "media-ready" },
      ],
    });
    const before = state;
    const outcome = rosterReducerWithOutcome(state, {
      type: "MESH_ROSTER_UPDATE_APPLIED",
      serverSeq: 4, // stale
      subjectPeerId: PEER_A,
      admissionIndex: 1,
      presence: "joined",
    });
    expect(outcome.kind).toBe("dropped-stale");
    state = meshRosterReducer(state, {
      type: "MESH_ROSTER_UPDATE_APPLIED",
      serverSeq: 4,
      subjectPeerId: PEER_A,
      admissionIndex: 1,
      presence: "joined",
    });
    // Slice unchanged on stale.
    expect(state).toBe(before);
    expect(state.byPeerId[PEER_A].presence).toBe("media-ready");
    // Equal serverSeq is also dropped.
    state = meshRosterReducer(state, {
      type: "MESH_ROSTER_UPDATE_APPLIED",
      serverSeq: 5,
      subjectPeerId: PEER_A,
      admissionIndex: 1,
      presence: "joined",
    });
    expect(state.byPeerId[PEER_A].presence).toBe("media-ready");
  });

  it("removes a participant on presence=released or left", () => {
    let state = meshRosterReducer(initialMeshRosterSlice, {
      type: "MESH_ROSTER_SNAPSHOT_APPLIED",
      serverSeq: 1,
      participants: [
        { peerId: PEER_A, admissionIndex: 1, presence: "joined" },
        { peerId: PEER_B, admissionIndex: 2, presence: "joined" },
      ],
    });
    state = meshRosterReducer(state, {
      type: "MESH_ROSTER_UPDATE_APPLIED",
      serverSeq: 2,
      subjectPeerId: PEER_A,
      admissionIndex: 1,
      presence: "released",
    });
    expect(state.byPeerId[PEER_A]).toBeUndefined();
    expect(state.byPeerId[PEER_B]).toBeDefined();

    state = meshRosterReducer(state, {
      type: "MESH_ROSTER_UPDATE_APPLIED",
      serverSeq: 3,
      subjectPeerId: PEER_B,
      admissionIndex: 2,
      presence: "left",
    });
    expect(state.byPeerId[PEER_B]).toBeUndefined();
  });

  it("ignores updates targeting selfPeerId for the byPeerId map but bumps serverSeq", () => {
    let state = meshRosterReducer(initialMeshRosterSlice, {
      type: "MESH_ROSTER_SNAPSHOT_APPLIED",
      serverSeq: 1,
      participants: [],
      selfPeerId: SELF,
    });
    state = meshRosterReducer(state, {
      type: "MESH_ROSTER_UPDATE_APPLIED",
      serverSeq: 2,
      subjectPeerId: SELF,
      admissionIndex: 4,
      presence: "media-ready",
      selfPeerId: SELF,
    });
    expect(state.byPeerId[SELF]).toBeUndefined();
    expect(state.serverSeq).toBe(2);
  });
});
