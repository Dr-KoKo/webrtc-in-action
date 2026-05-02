// Error code enum + `error` payload schema for the mesh signaling
// contract v2 (§3.19). Lives in its own file so the verb files
// importing the enum don't pull in every other message schema.
//
// The forbidden values (`room_full`, `invalid_room_id`,
// `screen_share_busy`) are absent here and audited by tests.

import { z } from "zod";
import { uuidSchema } from "./envelope";

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

export const errorPayloadSchema = z.object({
  code: errorCodeSchema,
  message: z.string().min(1),
  correlates: uuidSchema.optional(),
  context: z.record(z.unknown()).optional(),
});
