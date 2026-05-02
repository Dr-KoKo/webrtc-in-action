// Media slice unit tests (Phase 10 post-review).
//
// Pins three invariants that surfaced during code review:
//   1. `LOCAL_MEDIA_STATE_SET` replaces the local triplet only.
//   2. `REMOTE_MEDIA_STATE_CLEARED` sets `remote` back to null without
//      touching `local` (used when the peer leaves mid-call so the UI
//      does not render the departed peer's stale mic/camera state on
//      top of a subsequent pairing).
//   3. `MEDIA_STATE_RESET` returns the slice to its initial value
//      (used on session-idle / leave so a fresh rejoin starts from a
//      clean slate — button labels reflect the new stream).

import { describe, expect, it } from "vitest";
import {
  initialMediaSlice,
  mediaReducer,
  type MediaTriplet,
} from "@/modes/one-to-one/state/media";

const T_ON_OFF: MediaTriplet = {
  microphone: "on",
  camera: "off",
  screenShare: "inactive",
};
const T_OFF_ON: MediaTriplet = {
  microphone: "off",
  camera: "on",
  screenShare: "inactive",
};

describe("mediaReducer", () => {
  it("LOCAL_MEDIA_STATE_SET replaces only the local triplet", () => {
    const seeded = {
      local: initialMediaSlice.local,
      remote: T_OFF_ON,
    };
    const next = mediaReducer(seeded, {
      type: "LOCAL_MEDIA_STATE_SET",
      triplet: T_ON_OFF,
    });
    expect(next.local).toEqual(T_ON_OFF);
    expect(next.remote).toEqual(T_OFF_ON);
  });

  it("LOCAL_MEDIA_STATE_SET returns the same reference when unchanged", () => {
    const seeded = { ...initialMediaSlice, local: T_ON_OFF };
    const next = mediaReducer(seeded, {
      type: "LOCAL_MEDIA_STATE_SET",
      triplet: T_ON_OFF,
    });
    expect(next).toBe(seeded);
  });

  it("REMOTE_MEDIA_STATE_RECEIVED populates the remote triplet", () => {
    const next = mediaReducer(initialMediaSlice, {
      type: "REMOTE_MEDIA_STATE_RECEIVED",
      triplet: T_OFF_ON,
    });
    expect(next.remote).toEqual(T_OFF_ON);
    expect(next.local).toEqual(initialMediaSlice.local);
  });

  it("REMOTE_MEDIA_STATE_CLEARED resets remote to null, leaves local alone", () => {
    const seeded = { local: T_ON_OFF, remote: T_OFF_ON };
    const next = mediaReducer(seeded, { type: "REMOTE_MEDIA_STATE_CLEARED" });
    expect(next.remote).toBeNull();
    expect(next.local).toEqual(T_ON_OFF);
  });

  it("REMOTE_MEDIA_STATE_CLEARED returns the same reference when remote is already null", () => {
    const next = mediaReducer(initialMediaSlice, {
      type: "REMOTE_MEDIA_STATE_CLEARED",
    });
    expect(next).toBe(initialMediaSlice);
  });

  it("MEDIA_STATE_RESET returns the slice to its initial defaults", () => {
    const seeded = { local: T_ON_OFF, remote: T_OFF_ON };
    const next = mediaReducer(seeded, { type: "MEDIA_STATE_RESET" });
    expect(next).toEqual(initialMediaSlice);
  });
});
