// Envelope, primitives, and shared payload fragments for the
// canonical signaling contract v1
// (`specs/001-webrtc-1to1-call/contracts/signaling-protocol.md`).
//
// Per-type message schemas extend `roomScopedEnvelope` (see
// `./messages.ts`) so envelope-level fields are validated in exactly
// one place.

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
// 15 known types, before we dispatch on type?". Per-type schemas
// re-validate the payload shape.
export const envelopeSchema = envelopeBaseSchema;

// Helper: require roomId for room-scoped messages. Re-exported for
// per-type schemas in `./messages.ts`.
export const roomScopedEnvelope = z.object({
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
export const sdpBodySchema = (kind: "offer" | "answer") =>
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
