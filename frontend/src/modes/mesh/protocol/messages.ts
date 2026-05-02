// Per-type payload schemas for the mesh signaling contract v2
// (`specs/002-webrtc-mesh-room/contracts/signaling-protocol.md`,
// §3.1–§3.18). The `error` payload schema lives in `./errors.ts`;
// the top-level discriminated unions live in `./schema.ts`.

import { z } from "zod";
import {
  cameraStateSchema,
  iceCandidateInitSchema,
  iceServerSchema,
  mediaCapabilitiesSchema,
  micStateSchema,
  pairIdentitySchema,
  presenceSchema,
  remotePeerRefSchema,
  rosterReasonSchema,
  screenShareStateSchema,
  sdpBodySchema,
  uuidSchema,
} from "./envelope";

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
  microphone: micStateSchema,
  camera: cameraStateSchema,
  screenShare: screenShareStateSchema,
});
export type PairMediaStatePayload = z.infer<
  typeof pairMediaStatePayloadSchema
>;

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
