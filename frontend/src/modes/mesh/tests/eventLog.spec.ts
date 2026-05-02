// T038 — event-log reducer acceptance tests (data-model §B.6 / FR-061).
//
// Asserts:
//   1. Append + ring-buffer eviction at MESH_EVENT_LOG_CAPACITY.
//   2. peer-scoped entries MUST carry peerId; pair-scoped entries MUST
//      carry both peerId + pairId. Failures throw at construction.
//   3. Selectors: selectAll, selectByPeer, selectByPair, selectRoomScope.

import { describe, expect, it } from "vitest";
import {
  initialMeshEventLogSlice,
  makeMeshEventEntry,
  meshEventLogReducer,
  MESH_EVENT_LOG_CAPACITY,
  selectAll,
  selectByPair,
  selectByPeer,
  selectRoomScope,
} from "../state/eventLog";

const PEER_A = "11111111-1111-4111-8111-111111111111";
const PEER_B = "22222222-2222-4222-8222-222222222222";

describe("makeMeshEventEntry", () => {
  it("requires peerId for peer-scoped entries (FR-061)", () => {
    expect(() =>
      makeMeshEventEntry({
        scope: "peer",
        type: "mesh_roster_update_applied",
        summary: "missing peerId",
      }),
    ).toThrowError(/peerId/);
  });

  it("requires both peerId + pairId for pair-scoped entries", () => {
    expect(() =>
      makeMeshEventEntry({
        scope: "pair",
        type: "future_phase_message",
        summary: "missing pairId",
        peerId: PEER_A,
      }),
    ).toThrowError(/pairId/);
  });

  it("accepts room-scoped entries without peerId", () => {
    const entry = makeMeshEventEntry({
      scope: "room",
      type: "mesh_roster_snapshot_received",
      summary: "snapshot",
    });
    expect(entry.peerId).toBeUndefined();
  });
});

describe("meshEventLogReducer", () => {
  it("appends entries newest-at-end", () => {
    const a = makeMeshEventEntry({
      scope: "peer",
      type: "mesh_roster_update_applied",
      summary: "A joined",
      peerId: PEER_A,
    });
    const b = makeMeshEventEntry({
      scope: "peer",
      type: "mesh_roster_update_applied",
      summary: "B joined",
      peerId: PEER_B,
    });
    let state = meshEventLogReducer(initialMeshEventLogSlice, {
      type: "MESH_EVENT_APPEND",
      entry: a,
    });
    state = meshEventLogReducer(state, {
      type: "MESH_EVENT_APPEND",
      entry: b,
    });
    expect(state.entries.map((e) => e.id)).toEqual([a.id, b.id]);
  });

  it("evicts oldest entries past MESH_EVENT_LOG_CAPACITY", () => {
    let state = initialMeshEventLogSlice;
    for (let i = 0; i < MESH_EVENT_LOG_CAPACITY + 5; i++) {
      const entry = makeMeshEventEntry({
        scope: "room",
        type: "future_phase_message",
        summary: `entry-${i}`,
      });
      state = meshEventLogReducer(state, {
        type: "MESH_EVENT_APPEND",
        entry,
      });
    }
    expect(state.entries).toHaveLength(MESH_EVENT_LOG_CAPACITY);
    // The first 5 entries must have been evicted; the surviving newest
    // entry's summary is the highest-numbered.
    const last = state.entries[state.entries.length - 1];
    expect(last.summary).toBe(
      `entry-${MESH_EVENT_LOG_CAPACITY + 4}`,
    );
  });

  it("supports peer / pair / room selectors", () => {
    const peerEntry = makeMeshEventEntry({
      scope: "peer",
      type: "mesh_roster_update_applied",
      summary: "peer A → media-ready",
      peerId: PEER_A,
    });
    const pairEntry = makeMeshEventEntry({
      scope: "pair",
      type: "future_phase_message",
      summary: "pair 1-2 future",
      peerId: PEER_B,
      pairId: "1-2",
    });
    const roomEntry = makeMeshEventEntry({
      scope: "room",
      type: "mesh_roster_snapshot_received",
      summary: "snapshot",
    });
    const state = [peerEntry, pairEntry, roomEntry].reduce(
      (s, entry) =>
        meshEventLogReducer(s, { type: "MESH_EVENT_APPEND", entry }),
      initialMeshEventLogSlice,
    );

    expect(selectAll(state)).toHaveLength(3);
    expect(selectByPeer(state, PEER_A).map((e) => e.id)).toEqual([
      peerEntry.id,
    ]);
    expect(selectByPair(state, "1-2").map((e) => e.id)).toEqual([
      pairEntry.id,
    ]);
    expect(selectRoomScope(state).map((e) => e.id)).toEqual([roomEntry.id]);
  });
});

// M9 / T070 + T072 — event-log entries for the local toggle, the
// outbound `pair_media_state` send, and the inbound fan-out
// reception. These prove the reader can tell:
//   - that a local UI action happened (mesh_media_local_toggled),
//   - that the OUTBOUND signaling envelope went out (mesh_media_state_sent),
//   - that an INBOUND signaling envelope arrived (mesh_media_state_received),
//   - and that the messages travelled the SIGNALING METADATA path
//     (transport=signaling / path=metadata) — NOT the media path.
describe("M9 media-control event-log entries", () => {
  it("local mic toggle entry is local-scoped, human-readable, names the kind", () => {
    const entry = makeMeshEventEntry({
      scope: "local",
      type: "mesh_media_local_toggled",
      summary: "microphone toggled → off",
      detail: { kind: "microphone", next: "off" },
    });
    expect(entry.scope).toBe("local");
    expect(entry.type).toBe("mesh_media_local_toggled");
    expect(entry.summary).toMatch(/microphone toggled/);
    expect(entry.detail).toMatchObject({ kind: "microphone" });
  });

  it("outbound pair_media_state entry identifies signaling metadata path (not media)", () => {
    const entry = makeMeshEventEntry({
      scope: "room",
      type: "mesh_media_state_sent",
      summary:
        "pair_media_state sent (signaling metadata path; server fan-out, not media path)",
      detail: { transport: "signaling", path: "metadata" },
    });
    expect(entry.summary).toMatch(/signaling metadata path/);
    expect(entry.summary).toMatch(/not media path/);
    expect(entry.detail).toMatchObject({
      transport: "signaling",
      path: "metadata",
    });
  });

  it("inbound pair_media_state entry includes remotePeerId and metadata path", () => {
    const entry = makeMeshEventEntry({
      scope: "peer",
      type: "mesh_media_state_received",
      summary: `pair_media_state received from peer ${PEER_A.slice(0, 8)}… (signaling metadata path)`,
      peerId: PEER_A,
      detail: {
        transport: "signaling",
        path: "metadata",
        remotePeerId: PEER_A,
      },
    });
    expect(entry.scope).toBe("peer");
    expect(entry.peerId).toBe(PEER_A);
    expect(entry.detail).toMatchObject({
      transport: "signaling",
      path: "metadata",
      remotePeerId: PEER_A,
    });
    expect(entry.summary).toMatch(/signaling metadata path/);
  });

  it("inbound entry MUST satisfy FR-061 — peer-scoped means peerId required", () => {
    expect(() =>
      makeMeshEventEntry({
        scope: "peer",
        type: "mesh_media_state_received",
        summary: "peer-scoped without peerId is malformed",
      }),
    ).toThrowError(/peerId/);
  });
});
