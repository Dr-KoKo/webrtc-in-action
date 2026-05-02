// Shared `media_failed.payload.reason` enum vocabulary.
//
// Both the 001 (v1) and the 002 mesh (v2) signaling contracts agree on
// this 4-element set; pulling the type into `shared/` lets
// `shared/webrtc/media-acquisition.ts` classify a `getUserMedia` failure
// without importing a mode contract (boundary rule: shared MUST NOT
// import a mode).
//
// Each mode's signaling schema independently re-validates the wire
// payload against its own Zod enum and re-exports this type for
// convenience. Drift detection is structural — if a future mode adds a
// reason value, this file must be extended in lockstep.

export type MediaFailedReason =
  | "permission_denied"
  | "device_not_found"
  | "device_in_use"
  | "other";
