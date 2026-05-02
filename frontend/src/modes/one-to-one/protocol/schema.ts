// Top-level discriminated union for the signaling contract v1, plus
// the by-type schema map. Importers SHOULD pull from this barrel
// rather than reaching into `./envelope`, `./messages`, `./errors`
// directly — those are split by concern but the `protocol/` package
// is consumed as a single unit.

import { z } from "zod";
import {
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
} from "./messages";
import { errorSchema } from "./errors";

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

// Barrel re-exports — importers reach the entire protocol surface
// through this one path.
export {
  ROOM_ID_REGEX,
  CONTRACT_VERSION,
  messageTypes,
  messageTypeSchema,
  envelopeBaseSchema,
  envelopeSchema,
  roomScopedEnvelope,
  roomIdSchema,
  uuidSchema,
  timestampSchema,
  versionSchema,
  mediaCapabilitiesSchema,
  remotePeerSnapshotSchema,
  admissionOrderSchema,
  presenceSchema,
  presenceReasonSchema,
  iceServerSchema,
  iceCandidateInitSchema,
  sdpBodySchema,
} from "./envelope";

export type { MessageType, PresenceStatus } from "./envelope";

export {
  joinRoomSchema,
  joinAcceptedSchema,
  joinRejectedSchema,
  joinRejectedResultSchema,
  peerPresenceChangedSchema,
  mediaReadySchema,
  mediaFailedSchema,
  mediaFailedReasonSchema,
  readyForOfferSchema,
  offerSchema,
  answerSchema,
  iceCandidateSchema,
  mediaStateSchema,
  peerLeftSchema,
  participantReleasedSchema,
  participantReleasedResultSchema,
  leaveRoomSchema,
} from "./messages";

export type {
  JoinRoomMessage,
  JoinAcceptedMessage,
  JoinRejectedMessage,
  PeerPresenceChangedMessage,
  MediaReadyMessage,
  MediaFailedMessage,
  ReadyForOfferMessage,
  OfferMessage,
  AnswerMessage,
  IceCandidateMessage,
  MediaStateMessage,
  PeerLeftMessage,
  ParticipantReleasedMessage,
  LeaveRoomMessage,
} from "./messages";

export { errorCodeSchema, errorSchema } from "./errors";
export type { ErrorMessage } from "./errors";
