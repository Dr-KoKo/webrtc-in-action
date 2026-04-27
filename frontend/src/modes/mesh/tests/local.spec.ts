// T038 — local participant FSM tests (data-model §B.1).
//
// Asserts the join + media flow:
//   idle → joining → joined → acquiring-media → media-ready
//   joined → acquiring-media → media-error → joined → media-ready (retry)
//   any non-terminal → signaling-error on transport close.

import { describe, expect, it } from "vitest";
import {
  initialMeshLocalParticipant,
  meshLocalReducer,
} from "../state/local";

describe("meshLocalReducer", () => {
  it("walks idle → joining → joined → acquiring-media → media-ready", () => {
    let state = initialMeshLocalParticipant;
    state = meshLocalReducer(state, {
      type: "MESH_JOIN_REQUESTED",
      roomId: "demo",
    });
    expect(state.fsm).toBe("joining");
    expect(state.roomId).toBe("demo");

    state = meshLocalReducer(state, {
      type: "MESH_JOIN_ACCEPTED",
      peerId: "00000000-0000-4000-8000-000000000001",
      admissionIndex: 1,
    });
    expect(state.fsm).toBe("joined");
    expect(state.peerId).toBe("00000000-0000-4000-8000-000000000001");
    expect(state.admissionIndex).toBe(1);

    state = meshLocalReducer(state, { type: "MESH_MEDIA_ACQUIRE_STARTED" });
    expect(state.fsm).toBe("acquiring-media");

    state = meshLocalReducer(state, { type: "MESH_MEDIA_READY" });
    expect(state.fsm).toBe("media-ready");
  });

  it("transitions joining → idle on join_rejected", () => {
    let state = meshLocalReducer(initialMeshLocalParticipant, {
      type: "MESH_JOIN_REQUESTED",
      roomId: "demo",
    });
    state = meshLocalReducer(state, {
      type: "MESH_JOIN_REJECTED",
      result: "join_rejected_room_full",
      message: "full",
    });
    expect(state.fsm).toBe("idle");
    expect(state.roomId).toBeUndefined();
    expect(state.errorBanner?.kind).toBe("join-rejected");
  });

  it("retry path: media-error → joined; controller picks up acquisition", () => {
    let state = meshLocalReducer(initialMeshLocalParticipant, {
      type: "MESH_JOIN_REQUESTED",
      roomId: "demo",
    });
    state = meshLocalReducer(state, {
      type: "MESH_JOIN_ACCEPTED",
      peerId: "00000000-0000-4000-8000-000000000001",
      admissionIndex: 1,
    });
    state = meshLocalReducer(state, { type: "MESH_MEDIA_ACQUIRE_STARTED" });
    state = meshLocalReducer(state, {
      type: "MESH_MEDIA_FAILED",
      detail: "permission_denied",
    });
    expect(state.fsm).toBe("media-error");
    expect(state.errorBanner?.detail).toBe("permission_denied");

    state = meshLocalReducer(state, { type: "MESH_RETRY_REQUESTED" });
    expect(state.fsm).toBe("joined");
    expect(state.errorBanner).toBeUndefined();

    state = meshLocalReducer(state, { type: "MESH_MEDIA_ACQUIRE_STARTED" });
    state = meshLocalReducer(state, { type: "MESH_MEDIA_READY" });
    expect(state.fsm).toBe("media-ready");
  });

  it("invalid transitions are no-ops (e.g. media_ready from joined)", () => {
    let state = meshLocalReducer(initialMeshLocalParticipant, {
      type: "MESH_JOIN_REQUESTED",
      roomId: "demo",
    });
    state = meshLocalReducer(state, {
      type: "MESH_JOIN_ACCEPTED",
      peerId: "00000000-0000-4000-8000-000000000001",
      admissionIndex: 1,
    });
    const before = state;
    state = meshLocalReducer(state, { type: "MESH_MEDIA_READY" });
    expect(state).toBe(before);
    expect(state.fsm).toBe("joined");
  });

  it("transport closed mid-session yields signaling-error", () => {
    let state = meshLocalReducer(initialMeshLocalParticipant, {
      type: "MESH_JOIN_REQUESTED",
      roomId: "demo",
    });
    state = meshLocalReducer(state, {
      type: "MESH_JOIN_ACCEPTED",
      peerId: "00000000-0000-4000-8000-000000000001",
      admissionIndex: 1,
    });
    state = meshLocalReducer(state, {
      type: "MESH_TRANSPORT_CHANGED",
      transport: "closed",
    });
    expect(state.fsm).toBe("signaling-error");
    expect(state.errorBanner?.kind).toBe("signaling-error");
  });

  it("transport close while idle does not flip FSM", () => {
    let state = initialMeshLocalParticipant;
    state = meshLocalReducer(state, {
      type: "MESH_TRANSPORT_CHANGED",
      transport: "closed",
    });
    expect(state.fsm).toBe("idle");
    expect(state.errorBanner).toBeUndefined();
  });

  it("MESH_PARTICIPANT_RELEASED → released with media-error banner", () => {
    let state = meshLocalReducer(initialMeshLocalParticipant, {
      type: "MESH_JOIN_REQUESTED",
      roomId: "demo",
    });
    state = meshLocalReducer(state, {
      type: "MESH_JOIN_ACCEPTED",
      peerId: "00000000-0000-4000-8000-000000000001",
      admissionIndex: 1,
    });
    state = meshLocalReducer(state, {
      type: "MESH_PARTICIPANT_RELEASED",
      detail: "permission_denied",
    });
    expect(state.fsm).toBe("released");
    expect(state.errorBanner?.kind).toBe("media-error");
    expect(state.errorBanner?.detail).toBe("permission_denied");
  });
});
