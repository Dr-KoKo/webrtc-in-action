import { describe, it, expect } from "vitest";
import {
  ROOM_ID_REGEX,
  envelopeSchema,
  joinRoomSchema,
  joinAcceptedSchema,
  joinRejectedSchema,
  peerPresenceChangedSchema,
  mediaReadySchema,
  mediaFailedSchema,
  readyForOfferSchema,
  offerSchema,
  answerSchema,
  iceCandidateSchema,
  mediaStateSchema,
  peerLeftSchema,
  participantReleasedSchema,
  leaveRoomSchema,
  errorSchema,
  signalingMessageSchema,
} from "@/modes/one-to-one/protocol/schema";

// A stable UUIDv4 used across all fixtures — generating fresh UUIDs per
// test is unnecessary and makes failures harder to read.
const PEER_A = "11111111-2222-4333-8444-555555555555";
const PEER_B = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const REQ_ID = "deadbeef-0000-4000-8000-000000000001";

describe("room ID regex", () => {
  it("accepts 1–64 chars of [A-Za-z0-9._-]", () => {
    expect(ROOM_ID_REGEX.test("demo")).toBe(true);
    expect(ROOM_ID_REGEX.test("Demo.Room_01")).toBe(true);
    expect(ROOM_ID_REGEX.test("a")).toBe(true);
    expect(ROOM_ID_REGEX.test("a".repeat(64))).toBe(true);
  });

  it("rejects empty, too long, or disallowed characters", () => {
    expect(ROOM_ID_REGEX.test("")).toBe(false);
    expect(ROOM_ID_REGEX.test("a".repeat(65))).toBe(false);
    expect(ROOM_ID_REGEX.test("bad room!")).toBe(false);
    expect(ROOM_ID_REGEX.test("room/with/slash")).toBe(false);
  });
});

describe("envelope", () => {
  it("accepts a v=1 join_room envelope", () => {
    const parsed = envelopeSchema.safeParse({
      v: 1,
      type: "join_room",
      roomId: "demo",
      requestId: REQ_ID,
      payload: {},
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects v != 1 (unsupported_version path)", () => {
    const parsed = envelopeSchema.safeParse({
      v: 2,
      type: "join_room",
      roomId: "demo",
      requestId: REQ_ID,
      payload: {},
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects unknown message types", () => {
    const parsed = envelopeSchema.safeParse({
      v: 1,
      type: "room_full", // removed by review-pass 4
      roomId: "demo",
      payload: {},
    });
    expect(parsed.success).toBe(false);
  });
});

describe("join_room", () => {
  it("accepts a well-formed join_room", () => {
    const res = joinRoomSchema.safeParse({
      v: 1,
      type: "join_room",
      roomId: "demo",
      requestId: REQ_ID,
      ts: 1713500000000,
      payload: {},
    });
    expect(res.success).toBe(true);
  });

  it("requires a requestId", () => {
    const res = joinRoomSchema.safeParse({
      v: 1,
      type: "join_room",
      roomId: "demo",
      payload: {},
    });
    expect(res.success).toBe(false);
  });

  it("rejects a bad roomId", () => {
    const res = joinRoomSchema.safeParse({
      v: 1,
      type: "join_room",
      roomId: "bad room!",
      requestId: REQ_ID,
      payload: {},
    });
    expect(res.success).toBe(false);
  });
});

describe("join_accepted", () => {
  const good = {
    v: 1,
    type: "join_accepted",
    roomId: "demo",
    requestId: REQ_ID,
    payload: {
      peerId: PEER_A,
      admissionOrder: 1,
      roomReadiness: "waiting_for_media",
      remotePeer: null,
    },
  };

  it("accepts remotePeer = null and remotePeer snapshot", () => {
    expect(joinAcceptedSchema.safeParse(good).success).toBe(true);
    const withRemote = {
      ...good,
      payload: {
        ...good.payload,
        remotePeer: { peerId: PEER_B, mediaReadiness: "ready" },
      },
    };
    expect(joinAcceptedSchema.safeParse(withRemote).success).toBe(true);
  });

  it("rejects admissionOrder outside {1,2}", () => {
    const bad = {
      ...good,
      payload: { ...good.payload, admissionOrder: 3 },
    };
    expect(joinAcceptedSchema.safeParse(bad).success).toBe(false);
  });
});

describe("join_rejected", () => {
  it("accepts the two canonical result strings", () => {
    for (const result of [
      "join_rejected_room_full",
      "join_rejected_invalid_room",
    ] as const) {
      const msg = {
        v: 1,
        type: "join_rejected",
        roomId: "demo",
        requestId: REQ_ID,
        payload: {
          result,
          reason: result === "join_rejected_room_full" ? "room_full" : "invalid_room_id",
          message: "room is full",
        },
      };
      expect(joinRejectedSchema.safeParse(msg).success).toBe(true);
    }
  });

  it("rejects an arbitrary result string (room_full is NOT a result)", () => {
    const msg = {
      v: 1,
      type: "join_rejected",
      roomId: "demo",
      requestId: REQ_ID,
      payload: {
        result: "room_full",
        reason: "room_full",
        message: "x",
      },
    };
    expect(joinRejectedSchema.safeParse(msg).success).toBe(false);
  });
});

describe("peer_presence_changed", () => {
  it("accepts a valid presence + reason combination", () => {
    const msg = {
      v: 1,
      type: "peer_presence_changed",
      roomId: "demo",
      payload: {
        subjectPeerId: PEER_B,
        admissionOrder: 2,
        presence: "pending-media",
        reason: "admitted",
      },
    };
    expect(peerPresenceChangedSchema.safeParse(msg).success).toBe(true);
  });

  it("rejects unknown presence / reason enum values", () => {
    const msg = {
      v: 1,
      type: "peer_presence_changed",
      roomId: "demo",
      payload: {
        subjectPeerId: PEER_B,
        admissionOrder: 2,
        presence: "joined", // not a canonical enum value
        reason: "admitted",
      },
    };
    expect(peerPresenceChangedSchema.safeParse(msg).success).toBe(false);
  });
});

describe("media_ready", () => {
  it("accepts audio:true, video:true", () => {
    const msg = {
      v: 1,
      type: "media_ready",
      roomId: "demo",
      payload: { mediaCapabilities: { audio: true, video: true } },
    };
    expect(mediaReadySchema.safeParse(msg).success).toBe(true);
  });

  it("rejects audio:false (MVP requires both)", () => {
    const msg = {
      v: 1,
      type: "media_ready",
      roomId: "demo",
      payload: { mediaCapabilities: { audio: false, video: true } },
    };
    expect(mediaReadySchema.safeParse(msg).success).toBe(false);
  });

  it("rejects video:false", () => {
    const msg = {
      v: 1,
      type: "media_ready",
      roomId: "demo",
      payload: { mediaCapabilities: { audio: true, video: false } },
    };
    expect(mediaReadySchema.safeParse(msg).success).toBe(false);
  });
});

describe("media_failed", () => {
  it("accepts the four canonical reasons", () => {
    for (const reason of [
      "permission_denied",
      "device_not_found",
      "device_in_use",
      "other",
    ] as const) {
      const msg = {
        v: 1,
        type: "media_failed",
        roomId: "demo",
        payload: { reason },
      };
      expect(mediaFailedSchema.safeParse(msg).success).toBe(true);
    }
  });

  it("rejects an unknown reason", () => {
    const msg = {
      v: 1,
      type: "media_failed",
      roomId: "demo",
      payload: { reason: "timeout" },
    };
    expect(mediaFailedSchema.safeParse(msg).success).toBe(false);
  });
});

describe("ready_for_offer", () => {
  it("accepts role offerer + iceServers", () => {
    const msg = {
      v: 1,
      type: "ready_for_offer",
      roomId: "demo",
      to: PEER_A,
      payload: {
        role: "offerer",
        remotePeer: { peerId: PEER_B, admissionOrder: 2 },
        iceServers: [
          { urls: ["stun:stun.l.google.com:19302"] },
          { urls: "turn:turn.example.com:3478", username: "u", credential: "c" },
        ],
      },
    };
    expect(readyForOfferSchema.safeParse(msg).success).toBe(true);
  });

  it("rejects an unknown role value", () => {
    const msg = {
      v: 1,
      type: "ready_for_offer",
      roomId: "demo",
      to: PEER_A,
      payload: {
        role: "initiator",
        remotePeer: { peerId: PEER_B, admissionOrder: 2 },
        iceServers: [],
      },
    };
    expect(readyForOfferSchema.safeParse(msg).success).toBe(false);
  });
});

describe("offer / answer", () => {
  it("offer requires sdp.type = 'offer'", () => {
    const okOffer = {
      v: 1,
      type: "offer",
      roomId: "demo",
      payload: { sdp: { type: "offer", sdp: "v=0\r\n..." } },
    };
    expect(offerSchema.safeParse(okOffer).success).toBe(true);

    const badOffer = { ...okOffer, payload: { sdp: { type: "answer", sdp: "v=0\r\n" } } };
    expect(offerSchema.safeParse(badOffer).success).toBe(false);
  });

  it("answer requires sdp.type = 'answer'", () => {
    const okAnswer = {
      v: 1,
      type: "answer",
      roomId: "demo",
      payload: { sdp: { type: "answer", sdp: "v=0\r\n..." } },
    };
    expect(answerSchema.safeParse(okAnswer).success).toBe(true);
  });
});

describe("ice_candidate", () => {
  it("accepts end-of-candidates as { candidate: null }", () => {
    const msg = {
      v: 1,
      type: "ice_candidate",
      roomId: "demo",
      payload: { candidate: null },
    };
    expect(iceCandidateSchema.safeParse(msg).success).toBe(true);
  });

  it("accepts a populated candidate", () => {
    const msg = {
      v: 1,
      type: "ice_candidate",
      roomId: "demo",
      payload: {
        candidate: {
          candidate: "candidate:1 1 UDP 2113937151 192.0.2.1 54321 typ host",
          sdpMid: "0",
          sdpMLineIndex: 0,
          usernameFragment: "abcd1234",
        },
      },
    };
    expect(iceCandidateSchema.safeParse(msg).success).toBe(true);
  });

  it("rejects candidate: '' (empty string is NOT end-of-candidates)", () => {
    const msg = {
      v: 1,
      type: "ice_candidate",
      roomId: "demo",
      payload: { candidate: { candidate: "", sdpMid: "0", sdpMLineIndex: 0 } },
    };
    expect(iceCandidateSchema.safeParse(msg).success).toBe(false);
  });
});

describe("media_state", () => {
  it("requires all three fields (no partial updates)", () => {
    const full = {
      v: 1,
      type: "media_state",
      roomId: "demo",
      payload: { microphone: "off", camera: "on", screenShare: "inactive" },
    };
    expect(mediaStateSchema.safeParse(full).success).toBe(true);

    const partial = {
      v: 1,
      type: "media_state",
      roomId: "demo",
      payload: { microphone: "off" },
    };
    expect(mediaStateSchema.safeParse(partial).success).toBe(false);
  });
});

describe("peer_left", () => {
  it("only allows graceful_leave / disconnect reasons", () => {
    for (const reason of ["graceful_leave", "disconnect"] as const) {
      const msg = {
        v: 1,
        type: "peer_left",
        roomId: "demo",
        payload: { peerId: PEER_B, reason },
      };
      expect(peerLeftSchema.safeParse(msg).success).toBe(true);
    }
    const bad = {
      v: 1,
      type: "peer_left",
      roomId: "demo",
      payload: { peerId: PEER_B, reason: "media_failed" },
    };
    expect(peerLeftSchema.safeParse(bad).success).toBe(false);
  });
});

describe("participant_released", () => {
  it("accepts the two canonical result strings", () => {
    for (const result of [
      "participant_released_media_failed",
      "participant_released_disconnect",
    ] as const) {
      const msg = {
        v: 1,
        type: "participant_released",
        roomId: "demo",
        payload: {
          result,
          reason: result === "participant_released_media_failed" ? "media_failed" : "disconnect",
        },
      };
      expect(participantReleasedSchema.safeParse(msg).success).toBe(true);
    }
  });

  it("rejects participant_released_media_failed as envelope.type (it's a result, not a type)", () => {
    const bad = {
      v: 1,
      type: "participant_released_media_failed",
      roomId: "demo",
      payload: {},
    };
    expect(signalingMessageSchema.safeParse(bad).success).toBe(false);
  });
});

describe("leave_room", () => {
  it("accepts an empty payload", () => {
    const msg = {
      v: 1,
      type: "leave_room",
      roomId: "demo",
      payload: {},
    };
    expect(leaveRoomSchema.safeParse(msg).success).toBe(true);
  });
});

describe("error", () => {
  it("accepts every canonical code", () => {
    const codes = [
      "already_joined",
      "unexpected_media_ready",
      "unsupported_media_capability",
      "unexpected_offer",
      "unexpected_answer",
      "not_in_room",
      "malformed",
      "unsupported_version",
      "internal_error",
    ] as const;
    for (const code of codes) {
      const msg = {
        v: 1,
        type: "error",
        payload: { code, message: "test" },
      };
      expect(errorSchema.safeParse(msg).success).toBe(true);
    }
  });

  it("rejects room_full and invalid_room_id as error codes (they're join_rejected results)", () => {
    for (const code of ["room_full", "invalid_room_id"] as const) {
      const msg = {
        v: 1,
        type: "error",
        payload: { code, message: "x" },
      };
      expect(errorSchema.safeParse(msg).success).toBe(false);
    }
  });
});

describe("discriminated union dispatch", () => {
  it("rejects stale / invented envelope types", () => {
    for (const type of [
      "room_full",
      "peer_joined",
      "peer_state_changed",
      "participant_released_media_failed",
    ]) {
      const bad = { v: 1, type, roomId: "demo", payload: {} };
      expect(signalingMessageSchema.safeParse(bad).success).toBe(false);
    }
  });
});
