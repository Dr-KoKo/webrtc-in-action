// Zod schemas for the canonical signaling contract v1
// (`specs/001-webrtc-1to1-call/contracts/signaling-protocol.md`).
//
// This file is the single client-side source of truth for every message
// type. All inbound messages MUST be parsed through one of the per-type
// schemas below before touching application state. Outbound messages
// SHOULD be parsed locally too so a malformed producer is caught
// in-process instead of on the wire.
//
// The 15 canonical types are:
//   join_room, join_accepted, join_rejected, peer_presence_changed,
//   media_ready, media_failed, ready_for_offer, offer, answer,
//   ice_candidate, media_state, peer_left, participant_released,
//   leave_room, error.
//
// Types intentionally NOT present (removed by review-pass 4):
//   room_full, peer_joined, peer_state_changed,
//   participant_released_media_failed (the last of those is a
//   participant_released.payload.result value, not a type).

import { z } from "zod";

// ---------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------

export const ROOM_ID_REGEX = /^[A-Za-z0-9._-]{1,64}$/;

export const roomIdSchema = z
  .string()
  .regex(ROOM_ID_REGEX, "room ID must match ^[A-Za-z0-9._-]{1,64}$");

// UUIDv4 — server-assigned peer IDs and client-generated request IDs.
export const uuidSchema = z.string().uuid();

// Millisecond epoch; informational only.
export const timestampSchema = z.number().int().nonnegative();

// Contract version enum. Any inbound message with `v != 1` MUST be
// rejected as `unsupported_version`.
export const CONTRACT_VERSION = 1 as const;
export const versionSchema = z.literal(CONTRACT_VERSION);

// Enumerated 15 canonical message types. ORDER matters only for
// readability — Zod's enum is order-insensitive at runtime.
export const messageTypes = [
  "join_room",
  "join_accepted",
  "join_rejected",
  "peer_presence_changed",
  "media_ready",
  "media_failed",
  "ready_for_offer",
  "offer",
  "answer",
  "ice_candidate",
  "media_state",
  "peer_left",
  "participant_released",
  "leave_room",
  "error",
] as const;

export const messageTypeSchema = z.enum(messageTypes);
export type MessageType = z.infer<typeof messageTypeSchema>;

// ---------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------
//
// Every frame is a JSON object with this envelope. Per-type payload
// schemas below extend this base (via .extend()) so we keep one source
// of truth for envelope-level validation.

export const envelopeBaseSchema = z.object({
  v: versionSchema,
  type: messageTypeSchema,
  roomId: roomIdSchema.optional(),
  from: uuidSchema.optional(),
  to: uuidSchema.optional(),
  requestId: uuidSchema.optional(),
  ts: timestampSchema.optional(),
  payload: z.unknown(),
});

// Envelope schema used only to check "is this a v1 envelope of one of the
// 15 known types, before we dispatch on type?". Per-type schemas below
// re-validate the payload shape.
export const envelopeSchema = envelopeBaseSchema;

// Helper: require roomId for room-scoped messages.
const roomScopedEnvelope = z.object({
  v: versionSchema,
  roomId: roomIdSchema,
  from: uuidSchema.optional(),
  to: uuidSchema.optional(),
  requestId: uuidSchema.optional(),
  ts: timestampSchema.optional(),
});

// ---------------------------------------------------------------------
// Shared payload fragments
// ---------------------------------------------------------------------

export const mediaCapabilitiesSchema = z.object({
  audio: z.literal(true),
  video: z.literal(true),
});

export const remotePeerSnapshotSchema = z.object({
  peerId: uuidSchema,
  mediaReadiness: z.enum(["pending-media", "ready"]),
});

export const admissionOrderSchema = z.union([z.literal(1), z.literal(2)]);

export const presenceSchema = z.enum([
  "pending-media",
  "ready",
  "in-call",
  "left",
  "released",
]);
export type PresenceStatus = z.infer<typeof presenceSchema>;

export const presenceReasonSchema = z.enum([
  "admitted",
  "media_ready",
  "media_failed",
  "role_assigned",
  "graceful_leave",
  "disconnect",
  "pending_released",
]);

export const iceServerSchema = z.object({
  urls: z.union([z.string(), z.array(z.string()).nonempty()]),
  username: z.string().optional(),
  credential: z.string().optional(),
});

// SDP body: opaque string blob carried verbatim. The client library
// (`RTCPeerConnection.setLocalDescription` etc.) enforces the grammar —
// we do NOT parse SDP at the contract layer.
const sdpBodySchema = (kind: "offer" | "answer") =>
  z.object({
    type: z.literal(kind),
    sdp: z.string().min(1),
  });

// ICE candidate payload. `candidate: null` is the canonical
// end-of-candidates signal. The empty string is explicitly NOT
// equivalent and MUST be rejected as `malformed` (§3.10).
export const iceCandidateInitSchema = z.object({
  candidate: z.string().min(1),
  sdpMid: z.string().nullable().optional(),
  sdpMLineIndex: z.number().int().nullable().optional(),
  usernameFragment: z.string().nullable().optional(),
});

// ---------------------------------------------------------------------
// §3.1 join_room  (C→S)
// ---------------------------------------------------------------------

export const joinRoomSchema = roomScopedEnvelope.extend({
  type: z.literal("join_room"),
  requestId: uuidSchema,
  payload: z.object({}).strict(),
});

// ---------------------------------------------------------------------
// §3.2 join_accepted  (S→C, envelope.from omitted)
// ---------------------------------------------------------------------

export const joinAcceptedSchema = roomScopedEnvelope.extend({
  type: z.literal("join_accepted"),
  requestId: uuidSchema,
  payload: z.object({
    peerId: uuidSchema,
    admissionOrder: admissionOrderSchema,
    roomReadiness: z.enum([
      "empty",
      "waiting_for_media",
      "waiting_for_peer",
      "paired",
    ]),
    remotePeer: remotePeerSnapshotSchema.nullable(),
  }),
});

// ---------------------------------------------------------------------
// §3.3 join_rejected  (S→C)
// ---------------------------------------------------------------------

export const joinRejectedResultSchema = z.enum([
  "join_rejected_room_full",
  "join_rejected_invalid_room",
]);

export const joinRejectedSchema = roomScopedEnvelope.extend({
  type: z.literal("join_rejected"),
  requestId: uuidSchema,
  payload: z.object({
    result: joinRejectedResultSchema,
    reason: z.enum(["room_full", "invalid_room_id"]),
    message: z.string().min(1),
  }),
});

// ---------------------------------------------------------------------
// §3.4 peer_presence_changed  (S→B)
// ---------------------------------------------------------------------

export const peerPresenceChangedSchema = roomScopedEnvelope.extend({
  type: z.literal("peer_presence_changed"),
  payload: z.object({
    subjectPeerId: uuidSchema,
    admissionOrder: admissionOrderSchema,
    presence: presenceSchema,
    reason: presenceReasonSchema,
  }),
});

// ---------------------------------------------------------------------
// §3.5 media_ready  (C→S)
// ---------------------------------------------------------------------

export const mediaReadySchema = roomScopedEnvelope.extend({
  type: z.literal("media_ready"),
  payload: z.object({
    mediaCapabilities: mediaCapabilitiesSchema,
  }),
});

// ---------------------------------------------------------------------
// §3.6 media_failed  (C→S)
// ---------------------------------------------------------------------

export const mediaFailedReasonSchema = z.enum([
  "permission_denied",
  "device_not_found",
  "device_in_use",
  "other",
]);

export const mediaFailedSchema = roomScopedEnvelope.extend({
  type: z.literal("media_failed"),
  payload: z.object({
    reason: mediaFailedReasonSchema,
    detail: z.string().optional(),
  }),
});

// ---------------------------------------------------------------------
// §3.7 ready_for_offer  (S→B, role differs per recipient)
// ---------------------------------------------------------------------

export const readyForOfferSchema = roomScopedEnvelope.extend({
  type: z.literal("ready_for_offer"),
  to: uuidSchema,
  payload: z.object({
    role: z.enum(["offerer", "answerer"]),
    remotePeer: z.object({
      peerId: uuidSchema,
      admissionOrder: admissionOrderSchema,
    }),
    iceServers: z.array(iceServerSchema),
  }),
});

// ---------------------------------------------------------------------
// §3.8 offer  (relay)
// ---------------------------------------------------------------------

export const offerSchema = roomScopedEnvelope.extend({
  type: z.literal("offer"),
  payload: z.object({
    sdp: sdpBodySchema("offer"),
  }),
});

// ---------------------------------------------------------------------
// §3.9 answer  (relay)
// ---------------------------------------------------------------------

export const answerSchema = roomScopedEnvelope.extend({
  type: z.literal("answer"),
  payload: z.object({
    sdp: sdpBodySchema("answer"),
  }),
});

// ---------------------------------------------------------------------
// §3.10 ice_candidate  (relay; candidate: null = end-of-candidates)
// ---------------------------------------------------------------------

export const iceCandidateSchema = roomScopedEnvelope.extend({
  type: z.literal("ice_candidate"),
  payload: z.object({
    candidate: z.union([iceCandidateInitSchema, z.null()]),
  }),
});

// ---------------------------------------------------------------------
// §3.11 media_state  (relay; full state, no partials)
// ---------------------------------------------------------------------

export const mediaStateSchema = roomScopedEnvelope.extend({
  type: z.literal("media_state"),
  payload: z.object({
    microphone: z.enum(["on", "off"]),
    camera: z.enum(["on", "off"]),
    screenShare: z.enum(["active", "inactive"]),
  }),
});

// ---------------------------------------------------------------------
// §3.12 peer_left  (S→C, in-call convenience cleanup trigger ONLY)
// ---------------------------------------------------------------------

export const peerLeftSchema = roomScopedEnvelope.extend({
  type: z.literal("peer_left"),
  payload: z.object({
    peerId: uuidSchema,
    reason: z.enum(["graceful_leave", "disconnect"]),
  }),
});

// ---------------------------------------------------------------------
// §3.13 participant_released  (S→C, post-admission release)
// ---------------------------------------------------------------------

export const participantReleasedResultSchema = z.enum([
  "participant_released_media_failed",
  "participant_released_disconnect",
]);

export const participantReleasedSchema = roomScopedEnvelope.extend({
  type: z.literal("participant_released"),
  payload: z.object({
    result: participantReleasedResultSchema,
    reason: z.enum(["media_failed", "disconnect"]),
    detail: z.string().optional(),
  }),
});

// ---------------------------------------------------------------------
// §3.14 leave_room  (C→S)
// ---------------------------------------------------------------------

export const leaveRoomSchema = roomScopedEnvelope.extend({
  type: z.literal("leave_room"),
  payload: z.object({}).strict(),
});

// ---------------------------------------------------------------------
// §3.15 error  (S→C, or occasionally C→S to report client failures)
// ---------------------------------------------------------------------

export const errorCodeSchema = z.enum([
  "already_joined",
  "unexpected_media_ready",
  "unsupported_media_capability",
  "unexpected_offer",
  "unexpected_answer",
  "not_in_room",
  "malformed",
  "unsupported_version",
  "internal_error",
]);

export const errorSchema = envelopeBaseSchema.extend({
  type: z.literal("error"),
  // roomId intentionally optional here — some errors (unsupported_version,
  // malformed envelope) fire before the server knows a room scope.
  payload: z.object({
    code: errorCodeSchema,
    message: z.string().min(1),
    correlates: uuidSchema.optional(),
  }),
});

// ---------------------------------------------------------------------
// Discriminated union — dispatch target
// ---------------------------------------------------------------------

export const signalingMessageSchema = z.discriminatedUnion("type", [
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
]);

export type SignalingMessage = z.infer<typeof signalingMessageSchema>;

// Narrow-type helpers, re-exported via types/contract.ts (T010).
export type JoinRoomMessage = z.infer<typeof joinRoomSchema>;
export type JoinAcceptedMessage = z.infer<typeof joinAcceptedSchema>;
export type JoinRejectedMessage = z.infer<typeof joinRejectedSchema>;
export type PeerPresenceChangedMessage = z.infer<
  typeof peerPresenceChangedSchema
>;
export type MediaReadyMessage = z.infer<typeof mediaReadySchema>;
export type MediaFailedMessage = z.infer<typeof mediaFailedSchema>;
export type ReadyForOfferMessage = z.infer<typeof readyForOfferSchema>;
export type OfferMessage = z.infer<typeof offerSchema>;
export type AnswerMessage = z.infer<typeof answerSchema>;
export type IceCandidateMessage = z.infer<typeof iceCandidateSchema>;
export type MediaStateMessage = z.infer<typeof mediaStateSchema>;
export type PeerLeftMessage = z.infer<typeof peerLeftSchema>;
export type ParticipantReleasedMessage = z.infer<
  typeof participantReleasedSchema
>;
export type LeaveRoomMessage = z.infer<typeof leaveRoomSchema>;
export type ErrorMessage = z.infer<typeof errorSchema>;

export const schemasByType = {
  join_room: joinRoomSchema,
  join_accepted: joinAcceptedSchema,
  join_rejected: joinRejectedSchema,
  peer_presence_changed: peerPresenceChangedSchema,
  media_ready: mediaReadySchema,
  media_failed: mediaFailedSchema,
  ready_for_offer: readyForOfferSchema,
  offer: offerSchema,
  answer: answerSchema,
  ice_candidate: iceCandidateSchema,
  media_state: mediaStateSchema,
  peer_left: peerLeftSchema,
  participant_released: participantReleasedSchema,
  leave_room: leaveRoomSchema,
  error: errorSchema,
} as const;
