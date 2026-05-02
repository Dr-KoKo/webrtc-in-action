// Envelope, primitives, and shared payload fragments for the mesh
// signaling contract v2
// (`specs/002-webrtc-mesh-room/contracts/signaling-protocol.md`).
//
// Per-type message schemas live in `./messages.ts` and use the
// `taggedSchema` / `taggedRequestSchema` helpers exported from this
// file. The top-level discriminated unions live in `./schema.ts`.

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

// ---------------------------------------------------------------------
// Message-type enums (§3.1–§3.19)
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

export const mediaCapabilitiesSchema = z.object({
  audio: z.literal(true),
  video: z.literal(true),
});

export const micStateSchema = z.enum(["on", "off"]);
export const cameraStateSchema = z.enum(["on", "off"]);
export const screenShareStateSchema = z.enum(["active", "inactive"]);
export type MicState = z.infer<typeof micStateSchema>;
export type CameraState = z.infer<typeof cameraStateSchema>;
export type ScreenShareState = z.infer<typeof screenShareStateSchema>;

// ---------------------------------------------------------------------
// Tagged-payload helpers — used by every per-type schema in
// `./messages.ts` to produce the discriminated-union members in
// `./schema.ts`.
// ---------------------------------------------------------------------

export const taggedSchema = <T extends z.ZodTypeAny, L extends string>(
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
export const taggedRequestSchema = <
  T extends z.ZodTypeAny,
  L extends string,
>(
  type: L,
  payload: T,
) => taggedSchema(type, payload).extend({ requestId: uuidSchema });
