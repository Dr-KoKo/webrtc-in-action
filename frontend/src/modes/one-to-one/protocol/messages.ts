// Per-type payload schemas + their inferred TS types for the
// canonical signaling contract v1
// (`specs/001-webrtc-1to1-call/contracts/signaling-protocol.md`,
// §3.1–§3.14). The `error` message lives in `./errors.ts`; the
// top-level discriminated union and `schemasByType` map live in
// `./schema.ts`.

import { z } from "zod";
import {
  admissionOrderSchema,
  iceCandidateInitSchema,
  iceServerSchema,
  mediaCapabilitiesSchema,
  presenceReasonSchema,
  presenceSchema,
  remotePeerSnapshotSchema,
  roomScopedEnvelope,
  sdpBodySchema,
  uuidSchema,
} from "./envelope";

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
// Inferred TS types — re-exported via `./schema.ts` and
// `../types/contract.ts`.
// ---------------------------------------------------------------------

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
