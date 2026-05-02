// Error code enum + `error` message schema for the signaling
// contract v1 (§3.15). Lives in its own file so the verb files
// importing the enum don't pull in every other message schema.

import { z } from "zod";
import { envelopeBaseSchema, uuidSchema } from "./envelope";

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

export type ErrorMessage = z.infer<typeof errorSchema>;
