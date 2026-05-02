// T021 — client-side contract round-trip + invariant tests for the
// mesh v2 signaling contract. Asserts every example from
// `specs/002-webrtc-mesh-room/contracts/signaling-protocol.md §3` parses
// through the corresponding Zod schema, and asserts the forbidden
// surface (no `room_full`, no `screen_share_busy`, presence is exactly
// the 7-element vocabulary, every pair message requires `pairEpoch`).

import { describe, expect, it } from "vitest";
import {
  errorCodeSchema,
  joinAcceptedPayloadSchema,
  joinRejectedPayloadSchema,
  joinRoomPayloadSchema,
  leaveRoomPayloadSchema,
  meshAllMessageTypes,
  meshClientMessageSchema,
  meshRosterSnapshotPayloadSchema,
  meshRosterUpdatePayloadSchema,
  meshServerMessageSchema,
  mediaFailedPayloadSchema,
  mediaReadyPayloadSchema,
  pairAnswerPayloadSchema,
  pairFailedPayloadSchema,
  pairIceCandidatePayloadSchema,
  pairMediaStatePayloadSchema,
  pairNegotiationInstructionPayloadSchema,
  pairOfferPayloadSchema,
  participantReleasedPayloadSchema,
  peerLeftPayloadSchema,
  presenceValues,
  reconnectPairPayloadSchema,
} from "../signaling/schema";

const PEER_A = "11111111-2222-4333-8444-555555555555";
const PEER_B = "22222222-3333-4444-8555-666666666666";
const REQ = "deadbeef-0000-4000-8000-000000000001";

describe("mesh contract — admission family (§3.1–§3.3, §3.8, §3.17, §3.18)", () => {
  it("join_room round-trips", () => {
    expect(() => joinRoomPayloadSchema.parse({})).not.toThrow();
  });

  it("join_accepted round-trips with iceServers + admissionIndex", () => {
    expect(() =>
      joinAcceptedPayloadSchema.parse({
        peerId: PEER_A,
        admissionIndex: 3,
        iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }],
      }),
    ).not.toThrow();
  });

  it("join_rejected accepts room_full + invalid_room results", () => {
    expect(() =>
      joinRejectedPayloadSchema.parse({
        result: "join_rejected_room_full",
        reason: "room_full",
        message: "x",
      }),
    ).not.toThrow();
    expect(() =>
      joinRejectedPayloadSchema.parse({
        result: "join_rejected_invalid_room",
        reason: "invalid_room_id",
        message: "x",
      }),
    ).not.toThrow();
  });

  // C17 invariant: version mismatch is `error unsupported_version`,
  // NEVER a join_rejected.result value.
  it("join_rejected REJECTS join_rejected_unsupported_version", () => {
    expect(() =>
      joinRejectedPayloadSchema.parse({
        result: "join_rejected_unsupported_version",
        reason: "room_full",
        message: "x",
      }),
    ).toThrow();
  });

  it("participant_released round-trips with media_failed", () => {
    expect(() =>
      participantReleasedPayloadSchema.parse({
        result: "participant_released_media_failed",
        reason: "media_failed",
        detail: "camera_permission_denied",
      }),
    ).not.toThrow();
  });

  it("peer_left round-trips", () => {
    expect(() =>
      peerLeftPayloadSchema.parse({
        peerId: PEER_A,
        reason: "graceful_leave",
      }),
    ).not.toThrow();
  });

  it("leave_room round-trips with empty payload", () => {
    expect(() => leaveRoomPayloadSchema.parse({})).not.toThrow();
  });
});

describe("mesh contract — roster family (§3.4 + §3.5)", () => {
  it("mesh_roster_snapshot round-trips", () => {
    expect(() =>
      meshRosterSnapshotPayloadSchema.parse({
        serverSeq: 12,
        participants: [
          { peerId: PEER_A, admissionIndex: 1, presence: "connected" },
          { peerId: PEER_B, admissionIndex: 2, presence: "media-ready" },
        ],
      }),
    ).not.toThrow();
  });

  it("mesh_roster_update round-trips", () => {
    expect(() =>
      meshRosterUpdatePayloadSchema.parse({
        serverSeq: 17,
        subjectPeerId: PEER_A,
        admissionIndex: 3,
        presence: "media-ready",
        reason: "media_ready",
      }),
    ).not.toThrow();
  });

  it("presence enum is exactly the 7-element FR-013 vocabulary", () => {
    expect(presenceValues).toHaveLength(7);
    const expected = new Set([
      "joined",
      "media-ready",
      "connecting",
      "connected",
      "failed",
      "released",
      "left",
    ]);
    for (const p of presenceValues) {
      expect(expected.has(p)).toBe(true);
    }
  });

  it("mesh_roster_update rejects legacy 'in-call' presence", () => {
    expect(() =>
      meshRosterUpdatePayloadSchema.parse({
        serverSeq: 1,
        subjectPeerId: PEER_A,
        admissionIndex: 1,
        presence: "in-call",
        reason: "admitted",
      }),
    ).toThrow();
  });
});

describe("mesh contract — media-readiness family (§3.6 + §3.7)", () => {
  it("media_ready requires audio:true && video:true", () => {
    expect(() =>
      mediaReadyPayloadSchema.parse({
        mediaCapabilities: { audio: true, video: true },
      }),
    ).not.toThrow();
    expect(() =>
      mediaReadyPayloadSchema.parse({
        mediaCapabilities: { audio: false, video: true },
      }),
    ).toThrow();
    expect(() =>
      mediaReadyPayloadSchema.parse({
        mediaCapabilities: { audio: true, video: false },
      }),
    ).toThrow();
  });

  it("media_failed accepts canonical reasons", () => {
    for (const r of [
      "permission_denied",
      "device_not_found",
      "device_in_use",
      "other",
    ]) {
      expect(() =>
        mediaFailedPayloadSchema.parse({ reason: r }),
      ).not.toThrow();
    }
  });
});

describe("mesh contract — pair family (§3.9–§3.16)", () => {
  it("pair_negotiation_instruction round-trips", () => {
    expect(() =>
      pairNegotiationInstructionPayloadSchema.parse({
        pairId: "1-3",
        pairEpoch: 1,
        role: "offerer",
        remotePeer: { peerId: PEER_B, admissionIndex: 3 },
        iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }],
      }),
    ).not.toThrow();
  });

  // FR-022a — every pairwise message requires both pairId AND pairEpoch.
  it("pair_offer requires pairEpoch", () => {
    expect(() =>
      pairOfferPayloadSchema.parse({
        pairId: "1-3",
        sdp: { type: "offer", sdp: "v=0\r\n..." },
      }),
    ).toThrow();
  });

  it("pair_offer requires pairId", () => {
    expect(() =>
      pairOfferPayloadSchema.parse({
        pairEpoch: 1,
        sdp: { type: "offer", sdp: "v=0\r\n..." },
      }),
    ).toThrow();
  });

  it("pair_offer rejects sdp.type !== 'offer'", () => {
    expect(() =>
      pairOfferPayloadSchema.parse({
        pairId: "1-3",
        pairEpoch: 1,
        sdp: { type: "answer", sdp: "v=0\r\n..." },
      }),
    ).toThrow();
  });

  it("pair_answer rejects sdp.type !== 'answer'", () => {
    expect(() =>
      pairAnswerPayloadSchema.parse({
        pairId: "1-3",
        pairEpoch: 1,
        sdp: { type: "offer", sdp: "v=0\r\n..." },
      }),
    ).toThrow();
  });

  it("pair_ice_candidate accepts candidate:null (end-of-candidates)", () => {
    expect(() =>
      pairIceCandidatePayloadSchema.parse({
        pairId: "1-3",
        pairEpoch: 1,
        candidate: null,
      }),
    ).not.toThrow();
  });

  it("pair_ice_candidate rejects candidate:'' (must use null)", () => {
    expect(() =>
      pairIceCandidatePayloadSchema.parse({
        pairId: "1-3",
        pairEpoch: 1,
        candidate: { candidate: "" },
      }),
    ).toThrow();
  });

  // §3.13 note: pair_media_state is participant-level — it does NOT
  // carry pairId / pairEpoch on the wire.
  it("pair_media_state accepts a participant-level payload (no pairId/pairEpoch)", () => {
    expect(() =>
      pairMediaStatePayloadSchema.parse({
        microphone: "on",
        camera: "on",
        screenShare: "active",
      }),
    ).not.toThrow();
  });

  it("pair_media_state requires the full triple", () => {
    expect(() =>
      pairMediaStatePayloadSchema.parse({
        microphone: "on",
        camera: "on",
      }),
    ).toThrow();
    expect(() =>
      pairMediaStatePayloadSchema.parse({
        camera: "on",
        screenShare: "inactive",
      }),
    ).toThrow();
    expect(() =>
      pairMediaStatePayloadSchema.parse({
        microphone: "on",
        screenShare: "inactive",
      }),
    ).toThrow();
  });

  it("reconnect_pair round-trips", () => {
    expect(() =>
      reconnectPairPayloadSchema.parse({
        pairId: "1-3",
        observedEpoch: 1,
      }),
    ).not.toThrow();
  });

  it("pair_failed round-trips", () => {
    expect(() =>
      pairFailedPayloadSchema.parse({
        pairId: "1-3",
        pairEpoch: 1,
        reason: "ice_failure",
        detail: "iceConnectionState=failed",
      }),
    ).not.toThrow();
  });
});

describe("mesh contract — non-existence invariants", () => {
  it("'room_full' is NOT in meshAllMessageTypes", () => {
    expect(meshAllMessageTypes as readonly string[]).not.toContain("room_full");
  });

  it("'screen_share_busy' is NOT in meshAllMessageTypes", () => {
    expect(meshAllMessageTypes as readonly string[]).not.toContain(
      "screen_share_busy",
    );
  });

  it("no chat-bearing message type exists (FR-053)", () => {
    for (const t of meshAllMessageTypes) {
      expect(t.toLowerCase()).not.toContain("chat");
    }
  });

  it("'room_full' / 'invalid_room_id' / 'screen_share_busy' are NOT error codes", () => {
    for (const forbidden of [
      "room_full",
      "invalid_room_id",
      "screen_share_busy",
    ]) {
      expect(() => errorCodeSchema.parse(forbidden)).toThrow();
    }
  });

  it("client message union accepts a join_room envelope", () => {
    expect(() =>
      meshClientMessageSchema.parse({
        v: 2,
        type: "join_room",
        roomId: "demo",
        requestId: REQ,
        payload: {},
      }),
    ).not.toThrow();
  });

  it("server message union accepts a mesh_roster_snapshot envelope", () => {
    expect(() =>
      meshServerMessageSchema.parse({
        v: 2,
        type: "mesh_roster_snapshot",
        roomId: "demo",
        payload: {
          serverSeq: 1,
          participants: [
            { peerId: PEER_A, admissionIndex: 1, presence: "joined" },
          ],
        },
      }),
    ).not.toThrow();
  });

  it("envelope rejects v != 2", () => {
    expect(() =>
      meshClientMessageSchema.parse({
        v: 1,
        type: "join_room",
        roomId: "demo",
        requestId: REQ,
        payload: {},
      }),
    ).toThrow();
    expect(() =>
      meshClientMessageSchema.parse({
        v: 3,
        type: "join_room",
        roomId: "demo",
        requestId: REQ,
        payload: {},
      }),
    ).toThrow();
  });
});

// F-1: contract §3.1 / §3.2 / §3.3 list `requestId` as required for
// the admission family (`join_room`, `join_accepted`, `join_rejected`).
// All other taggedSchema types leave `requestId` optional. Verify both
// ends of that boundary.
describe("mesh contract — admission family requires requestId (F-1)", () => {
  const PEER = "11111111-1111-4111-8111-111111111111";

  it("rejects join_room without requestId", () => {
    expect(() =>
      meshClientMessageSchema.parse({
        v: 2,
        type: "join_room",
        roomId: "demo",
        // requestId omitted
        payload: {},
      }),
    ).toThrow();
  });

  it("rejects join_accepted without requestId", () => {
    expect(() =>
      meshServerMessageSchema.parse({
        v: 2,
        type: "join_accepted",
        roomId: "demo",
        // requestId omitted
        payload: {
          peerId: PEER,
          admissionIndex: 1,
          iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }],
        },
      }),
    ).toThrow();
  });

  it("rejects join_rejected without requestId", () => {
    expect(() =>
      meshServerMessageSchema.parse({
        v: 2,
        type: "join_rejected",
        roomId: "demo",
        // requestId omitted
        payload: {
          result: "join_rejected_room_full",
          reason: "room_full",
          message: "full",
        },
      }),
    ).toThrow();
  });

  // Negative-of-negative: non-admission types still parse without
  // requestId, proving the override is admission-family-scoped.
  it("accepts mesh_roster_update without requestId (server-originated)", () => {
    expect(() =>
      meshServerMessageSchema.parse({
        v: 2,
        type: "mesh_roster_update",
        roomId: "demo",
        // requestId omitted — should be fine
        payload: {
          serverSeq: 1,
          subjectPeerId: PEER,
          admissionIndex: 1,
          presence: "joined",
          reason: "admitted",
        },
      }),
    ).not.toThrow();
  });

  it("accepts leave_room without requestId (client-originated)", () => {
    expect(() =>
      meshClientMessageSchema.parse({
        v: 2,
        type: "leave_room",
        roomId: "demo",
        // requestId omitted — should be fine
        payload: {},
      }),
    ).not.toThrow();
  });
});
