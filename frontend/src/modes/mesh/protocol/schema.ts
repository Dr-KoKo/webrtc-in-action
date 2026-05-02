// Top-level discriminated unions for the mesh signaling contract v2,
// plus barrel re-exports of the rest of the protocol surface.
// Importers SHOULD pull from this barrel rather than reaching into
// `./envelope`, `./messages`, `./errors` directly — those are split
// by concern but the `protocol/` package is consumed as a single unit.

import { z } from "zod";
import { taggedRequestSchema, taggedSchema } from "./envelope";
import {
  joinAcceptedPayloadSchema,
  joinRejectedPayloadSchema,
  joinRoomPayloadSchema,
  leaveRoomPayloadSchema,
  mediaFailedPayloadSchema,
  mediaReadyPayloadSchema,
  meshRosterSnapshotPayloadSchema,
  meshRosterUpdatePayloadSchema,
  pairAnswerPayloadSchema,
  pairFailedPayloadSchema,
  pairIceCandidatePayloadSchema,
  pairMediaStatePayloadSchema,
  pairNegotiationInstructionPayloadSchema,
  pairOfferPayloadSchema,
  pairReconnectInstructionPayloadSchema,
  participantReleasedPayloadSchema,
  peerLeftPayloadSchema,
  reconnectPairPayloadSchema,
} from "./messages";
import { errorPayloadSchema } from "./errors";

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

// Barrel re-exports — importers reach the entire protocol surface
// through this one path.
export {
  MESH_CONTRACT_VERSION,
  ROOM_ID_REGEX,
  roomIdSchema,
  uuidSchema,
  timestampSchema,
  versionSchema,
  presenceValues,
  presenceSchema,
  rosterReasonSchema,
  meshClientMessageTypes,
  meshServerMessageTypes,
  meshAllMessageTypes,
  meshMessageTypeSchema,
  meshEnvelopeSchema,
  iceServerSchema,
  remotePeerRefSchema,
  sdpBodySchema,
  iceCandidateInitSchema,
  pairIdentitySchema,
  mediaCapabilitiesSchema,
  micStateSchema,
  cameraStateSchema,
  screenShareStateSchema,
  taggedSchema,
  taggedRequestSchema,
} from "./envelope";

export type {
  Presence,
  MeshMessageType,
  MeshEnvelope,
  MicState,
  CameraState,
  ScreenShareState,
} from "./envelope";

export {
  joinRoomPayloadSchema,
  joinAcceptedPayloadSchema,
  joinRejectedResultSchema,
  joinRejectedPayloadSchema,
  participantReleasedPayloadSchema,
  peerLeftPayloadSchema,
  leaveRoomPayloadSchema,
  rosterParticipantSchema,
  meshRosterSnapshotPayloadSchema,
  meshRosterUpdatePayloadSchema,
  mediaReadyPayloadSchema,
  mediaFailedPayloadSchema,
  pairRoleSchema,
  pairNegotiationInstructionPayloadSchema,
  pairReconnectInstructionPayloadSchema,
  pairOfferPayloadSchema,
  pairAnswerPayloadSchema,
  pairIceCandidatePayloadSchema,
  pairMediaStatePayloadSchema,
  reconnectPairPayloadSchema,
  pairFailedPayloadSchema,
} from "./messages";

export type { PairMediaStatePayload } from "./messages";

export { errorCodeSchema, errorPayloadSchema } from "./errors";
