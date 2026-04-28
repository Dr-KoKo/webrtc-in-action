// Zod schemas for the canonical mesh signaling contract v2
// (`specs/002-webrtc-mesh-room/contracts/signaling-protocol.md`).
//
// This file is the single client-side source of truth for every mesh
// message type. All inbound mesh messages MUST be parsed through one
// of the per-type schemas below before touching application state.
//
// Mirror layer: the Go server schema lives in
// `signaling/internal/mesh/protocol*.go`. Both sides derive from the
// same contract — keeping the enum vocabularies and required fields
// in sync is a release blocker.
//
// Forbidden message types (compile-time non-existence — guarded by
// `tests/contract.spec.ts`): `room_full`, `screen_share_busy`,
// `chat_message`, `mesh_chat`. Pre-admission rejection lives on
// `join_rejected`; chat lives on RTCDataChannel.

import { z } from "zod";

// ---------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------

export const MESH_CONTRACT_VERSION = 2 as const;

export const ROOM_ID_REGEX = /^[A-Za-z0-9._-]{1,64}$/;
export const roomIdSchema = z
  .string()
  .regex(ROOM_ID_REGEX, "room ID must match ^[A-Za-z0-9._-]{1,64}$");

export const uuidSchema = z.string().uuid();
export const timestampSchema = z.number().int().nonnegative();
export const versionSchema = z.literal(MESH_CONTRACT_VERSION);

// 7-element presence vocabulary (FR-013). Order is irrelevant at
// runtime; kept here for cross-reference to the contract.
export const presenceValues = [
  "joined",
  "media-ready",
  "connecting",
  "connected",
  "failed",
  "released",
  "left",
] as const;
export const presenceSchema = z.enum(presenceValues);
export type Presence = z.infer<typeof presenceSchema>;

// `mesh_roster_update.reason` short-tag enum.
export const rosterReasonSchema = z.enum([
  "admitted",
  "media_ready",
  "media_failed",
  "pair_connecting",
  "pair_connected",
  "pair_failed",
  "graceful_leave",
  "disconnect",
  "pending_released",
]);

// `error.code` canonical enum (§3.19). The forbidden values
// (`room_full`, `invalid_room_id`, `screen_share_busy`) are absent
// here and audited by tests.
export const errorCodeSchema = z.enum([
  "already_joined",
  "unsupported_version",
  "malformed",
  "not_in_room",
  "unexpected_media_ready",
  "unsupported_media_capability",
  "unexpected_offer",
  "unexpected_answer",
  "stale_pair_epoch",
  "stale_roster_update",
  "internal_error",
]);

// ---------------------------------------------------------------------
// Message-type enum (§3.1–§3.19)
// ---------------------------------------------------------------------

export const meshClientMessageTypes = [
  "join_room",
  "media_ready",
  "media_failed",
  "pair_offer",
  "pair_answer",
  "pair_ice_candidate",
  "pair_media_state",
  "pair_failed",
  "reconnect_pair",
  "leave_room",
  "error",
] as const;

export const meshServerMessageTypes = [
  "join_accepted",
  "join_rejected",
  "mesh_roster_snapshot",
  "mesh_roster_update",
  "participant_released",
  "pair_negotiation_instruction",
  "pair_offer",
  "pair_answer",
  "pair_ice_candidate",
  "pair_media_state",
  "pair_reconnect_instruction",
  "pair_failed",
  "peer_left",
  "error",
] as const;

export const meshAllMessageTypes = [
  "join_room",
  "join_accepted",
  "join_rejected",
  "mesh_roster_snapshot",
  "mesh_roster_update",
  "media_ready",
  "media_failed",
  "participant_released",
  "pair_negotiation_instruction",
  "pair_offer",
  "pair_answer",
  "pair_ice_candidate",
  "pair_media_state",
  "reconnect_pair",
  "pair_reconnect_instruction",
  "pair_failed",
  "peer_left",
  "leave_room",
  "error",
] as const;

export const meshMessageTypeSchema = z.enum(meshAllMessageTypes);
export type MeshMessageType = z.infer<typeof meshMessageTypeSchema>;

// ---------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------

export const meshEnvelopeSchema = z.object({
  v: versionSchema,
  type: meshMessageTypeSchema,
  roomId: roomIdSchema.optional(),
  from: uuidSchema.optional(),
  to: uuidSchema.optional(),
  requestId: uuidSchema.optional(),
  ts: timestampSchema.optional(),
  payload: z.unknown(),
});
export type MeshEnvelope = z.infer<typeof meshEnvelopeSchema>;

// ---------------------------------------------------------------------
// Shared payload fragments
// ---------------------------------------------------------------------

export const iceServerSchema = z.object({
  urls: z.union([z.string(), z.array(z.string())]),
  username: z.string().optional(),
  credential: z.string().optional(),
});

export const remotePeerRefSchema = z.object({
  peerId: uuidSchema,
  admissionIndex: z.number().int().positive(),
});

export const sdpBodySchema = z.object({
  type: z.string(),
  sdp: z.string().min(1),
});

export const iceCandidateInitSchema = z.object({
  candidate: z.string(),
  sdpMid: z.string().nullable().optional(),
  sdpMLineIndex: z.number().int().nullable().optional(),
  usernameFragment: z.string().nullable().optional(),
});

export const pairIdentitySchema = z.object({
  pairId: z.string().min(1),
  pairEpoch: z.number().int().positive(),
});

// ---------------------------------------------------------------------
// Admission family (§3.1–§3.3, §3.8, §3.17, §3.18)
// ---------------------------------------------------------------------

export const joinRoomPayloadSchema = z.object({}).strict();

export const joinAcceptedPayloadSchema = z.object({
  peerId: uuidSchema,
  admissionIndex: z.number().int().positive(),
  iceServers: z.array(iceServerSchema).min(1),
});

// `join_rejected.result` is exactly two values. Version mismatch is
// `error { code: "unsupported_version" }` — NEVER a join_rejected
// result. The Zod enum below enforces this at parse time.
export const joinRejectedResultSchema = z.enum([
  "join_rejected_room_full",
  "join_rejected_invalid_room",
]);

export const joinRejectedPayloadSchema = z.object({
  result: joinRejectedResultSchema,
  reason: z.enum(["room_full", "invalid_room_id"]),
  message: z.string().min(1),
});

export const participantReleasedPayloadSchema = z.object({
  result: z.enum([
    "participant_released_media_failed",
    "participant_released_disconnect",
  ]),
  reason: z.enum(["media_failed", "disconnect"]),
  detail: z.string().optional(),
});

export const peerLeftPayloadSchema = z.object({
  peerId: uuidSchema,
  reason: z.enum(["graceful_leave", "disconnect"]),
});

export const leaveRoomPayloadSchema = z.object({}).strict();

// ---------------------------------------------------------------------
// Roster family (§3.4 + §3.5)
// ---------------------------------------------------------------------

export const rosterParticipantSchema = z.object({
  peerId: uuidSchema,
  admissionIndex: z.number().int().positive(),
  presence: presenceSchema,
});

export const meshRosterSnapshotPayloadSchema = z.object({
  serverSeq: z.number().int().nonnegative(),
  participants: z.array(rosterParticipantSchema),
});

export const meshRosterUpdatePayloadSchema = z.object({
  serverSeq: z.number().int().nonnegative(),
  subjectPeerId: uuidSchema,
  admissionIndex: z.number().int().positive(),
  presence: presenceSchema,
  reason: rosterReasonSchema,
});

// ---------------------------------------------------------------------
// Media-readiness family (§3.6 + §3.7)
// ---------------------------------------------------------------------

export const mediaCapabilitiesSchema = z.object({
  audio: z.literal(true),
  video: z.literal(true),
});

export const mediaReadyPayloadSchema = z.object({
  mediaCapabilities: mediaCapabilitiesSchema,
});

export const mediaFailedPayloadSchema = z.object({
  reason: z.enum([
    "permission_denied",
    "device_not_found",
    "device_in_use",
    "other",
  ]),
  detail: z.string().optional(),
});

// ---------------------------------------------------------------------
// Pair family (§3.9–§3.16)
// ---------------------------------------------------------------------

export const pairRoleSchema = z.enum(["offerer", "answerer"]);

export const pairNegotiationInstructionPayloadSchema =
  pairIdentitySchema.extend({
    role: pairRoleSchema,
    remotePeer: remotePeerRefSchema,
    iceServers: z.array(iceServerSchema).min(1),
  });

export const pairReconnectInstructionPayloadSchema =
  pairNegotiationInstructionPayloadSchema;

export const pairOfferPayloadSchema = pairIdentitySchema.extend({
  sdp: sdpBodySchema.refine((s) => s.type === "offer", {
    message: "pair_offer.sdp.type must be 'offer'",
  }),
});

export const pairAnswerPayloadSchema = pairIdentitySchema.extend({
  sdp: sdpBodySchema.refine((s) => s.type === "answer", {
    message: "pair_answer.sdp.type must be 'answer'",
  }),
});

// `pair_ice_candidate` distinguishes:
//   - candidate: <init>      — normal trickle (candidate.candidate non-empty)
//   - candidate: null        — end-of-candidates
//   - missing key            — malformed
//   - candidate: ""          — malformed (must use null)
export const pairIceCandidatePayloadSchema = pairIdentitySchema.extend({
  candidate: iceCandidateInitSchema
    .refine((c) => c.candidate !== "", {
      message: "candidate.candidate must not be empty (use null for end-of-candidates)",
    })
    .nullable(),
});

// `pair_media_state` is participant-level (§3.13 note): it does NOT
// carry pairId or pairEpoch on the wire. Server fans out to all other
// participants in the same room.
export const pairMediaStatePayloadSchema = z.object({
  microphone: z.enum(["on", "off"]),
  camera: z.enum(["on", "off"]),
  screenShare: z.enum(["active", "inactive"]),
});

export const reconnectPairPayloadSchema = z.object({
  pairId: z.string().min(1),
  observedEpoch: z.number().int().positive(),
});

export const pairFailedPayloadSchema = pairIdentitySchema.extend({
  reason: z.enum([
    "ice_failure",
    "dtls_failure",
    "transport_drop",
    "connection_state_failed",
    "application",
  ]),
  detail: z.string().optional(),
});

// ---------------------------------------------------------------------
// Error envelope (§3.19)
// ---------------------------------------------------------------------

export const errorPayloadSchema = z.object({
  code: errorCodeSchema,
  message: z.string().min(1),
  correlates: uuidSchema.optional(),
  context: z.record(z.unknown()).optional(),
});

// ---------------------------------------------------------------------
// Tagged-payload helpers — produces a discriminated union by `type`.
// ---------------------------------------------------------------------

const taggedSchema = <T extends z.ZodTypeAny, L extends string>(
  type: L,
  payload: T,
) =>
  z.object({
    v: versionSchema,
    type: z.literal(type),
    roomId: roomIdSchema.optional(),
    from: uuidSchema.optional(),
    to: uuidSchema.optional(),
    requestId: uuidSchema.optional(),
    ts: timestampSchema.optional(),
    payload,
  });

// Admission family (§3.1 / §3.2 / §3.3) require requestId — the
// request carries it to correlate; the server echoes it on
// join_accepted / join_rejected. The other taggedSchema types leave
// requestId optional. `.extend({ requestId })` upgrades the optional
// shape to required (Zod-3 merge semantics replace the existing key).
const taggedRequestSchema = <T extends z.ZodTypeAny, L extends string>(
  type: L,
  payload: T,
) => taggedSchema(type, payload).extend({ requestId: uuidSchema });

// Client → server messages.
export const meshClientMessageSchema = z.discriminatedUnion("type", [
  taggedRequestSchema("join_room", joinRoomPayloadSchema),
  taggedSchema("media_ready", mediaReadyPayloadSchema),
  taggedSchema("media_failed", mediaFailedPayloadSchema),
  taggedSchema("pair_offer", pairOfferPayloadSchema),
  taggedSchema("pair_answer", pairAnswerPayloadSchema),
  taggedSchema("pair_ice_candidate", pairIceCandidatePayloadSchema),
  taggedSchema("pair_media_state", pairMediaStatePayloadSchema),
  taggedSchema("pair_failed", pairFailedPayloadSchema),
  taggedSchema("reconnect_pair", reconnectPairPayloadSchema),
  taggedSchema("leave_room", leaveRoomPayloadSchema),
  taggedSchema("error", errorPayloadSchema),
]);
export type MeshClientMessage = z.infer<typeof meshClientMessageSchema>;

// Server → client messages.
export const meshServerMessageSchema = z.discriminatedUnion("type", [
  taggedRequestSchema("join_accepted", joinAcceptedPayloadSchema),
  taggedRequestSchema("join_rejected", joinRejectedPayloadSchema),
  taggedSchema("mesh_roster_snapshot", meshRosterSnapshotPayloadSchema),
  taggedSchema("mesh_roster_update", meshRosterUpdatePayloadSchema),
  taggedSchema("participant_released", participantReleasedPayloadSchema),
  taggedSchema(
    "pair_negotiation_instruction",
    pairNegotiationInstructionPayloadSchema,
  ),
  taggedSchema("pair_offer", pairOfferPayloadSchema),
  taggedSchema("pair_answer", pairAnswerPayloadSchema),
  taggedSchema("pair_ice_candidate", pairIceCandidatePayloadSchema),
  taggedSchema("pair_media_state", pairMediaStatePayloadSchema),
  taggedSchema(
    "pair_reconnect_instruction",
    pairReconnectInstructionPayloadSchema,
  ),
  taggedSchema("pair_failed", pairFailedPayloadSchema),
  taggedSchema("peer_left", peerLeftPayloadSchema),
  taggedSchema("error", errorPayloadSchema),
]);
export type MeshServerMessage = z.infer<typeof meshServerMessageSchema>;
