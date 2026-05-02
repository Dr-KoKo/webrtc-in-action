// Static types for the signaling contract v1, re-exported from the
// Zod schemas so there is exactly one definition per message shape.
//
// Keep this file a thin re-export; per T010, all types are derived via
// `z.infer<typeof schema>` inside `../protocol/` and we do NOT
// hand-write payload shapes here.

export {
  CONTRACT_VERSION,
  ROOM_ID_REGEX,
  messageTypes,
} from "../protocol/schema";

export type {
  MessageType,
  PresenceStatus,
  SignalingMessage,
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
  ErrorMessage,
} from "../protocol/schema";
