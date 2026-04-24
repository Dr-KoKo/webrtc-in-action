// T049 — media-acquisition reason classification + Phase 6 reducer
// transitions.
//
// Guards two places regressions love to hide:
// 1. Browser error-name mapping (NotAllowedError / NotFoundError /
//    NotReadableError / other) → contract media_failed.reason enum.
// 2. Session FSM transitions reachable only in Phase 6:
//    pending-media → waiting-for-peer, pending-media → media-error
//    (media_failed only), media-error → joining (Retry), media-error
//    → idle (Leave).

import { describe, expect, it } from "vitest";
import {
  acquireLocalMedia,
  classifyMediaError,
  stopTracks,
} from "../../src/webrtc/media-acquisition";
import {
  initialSessionSlice,
  sessionReducer,
  IllegalSessionTransitionError,
  type SessionAction,
  type SessionSlice,
} from "../../src/state/session";
import type {
  JoinAcceptedMessage,
  ParticipantReleasedMessage,
} from "../../src/types/contract";

const ROOM = "demo";
const SELF_ID = "11111111-1111-4111-8111-111111111111";
const REQ_ID = "33333333-3333-4333-8333-333333333333";

function joinAccepted(order: 1 | 2 = 1): JoinAcceptedMessage {
  return {
    v: 1,
    type: "join_accepted",
    roomId: ROOM,
    requestId: REQ_ID,
    payload: {
      peerId: SELF_ID,
      admissionOrder: order,
      roomReadiness: "waiting_for_media",
      remotePeer: null,
    },
  };
}

function participantReleased(
  reason: "media_failed" | "disconnect",
): ParticipantReleasedMessage {
  return {
    v: 1,
    type: "participant_released",
    roomId: ROOM,
    payload: {
      result:
        reason === "media_failed"
          ? "participant_released_media_failed"
          : "participant_released_disconnect",
      reason,
    },
  };
}

function run(state: SessionSlice, actions: SessionAction[]): SessionSlice {
  return actions.reduce((s, a) => sessionReducer(s, a), state);
}

describe("classifyMediaError", () => {
  it.each([
    ["NotAllowedError", "permission_denied"],
    ["SecurityError", "permission_denied"],
    ["PermissionDeniedError", "permission_denied"],
    ["NotFoundError", "device_not_found"],
    ["DevicesNotFoundError", "device_not_found"],
    ["NotReadableError", "device_in_use"],
    ["TrackStartError", "device_in_use"],
    ["AbortError", "device_in_use"],
    ["TypeError", "other"],
    ["OverconstrainedError", "other"],
  ])("maps %s → %s", (errorName, expectedReason) => {
    const err = Object.assign(new Error("mock"), { name: errorName });
    expect(classifyMediaError(err).reason).toBe(expectedReason);
  });

  it("falls back to 'other' for non-Error rejections", () => {
    expect(classifyMediaError("string thrown").reason).toBe("other");
    expect(classifyMediaError(null).reason).toBe("other");
    expect(classifyMediaError(undefined).reason).toBe("other");
  });

  it("captures the message in detail when present", () => {
    const err = Object.assign(new Error("user denied camera"), {
      name: "NotAllowedError",
    });
    const out = classifyMediaError(err);
    expect(out.reason).toBe("permission_denied");
    expect(out.detail).toBe("user denied camera");
  });
});

describe("acquireLocalMedia", () => {
  it("returns ok:true + stream on success", async () => {
    const fake = { id: "fake-stream" } as unknown as MediaStream;
    const result = await acquireLocalMedia({
      getUserMedia: async () => fake,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.stream).toBe(fake);
  });

  it("returns ok:false + reason on rejection, without throwing", async () => {
    const err = Object.assign(new Error("denied"), {
      name: "NotAllowedError",
    });
    const result = await acquireLocalMedia({
      getUserMedia: async () => {
        throw err;
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("permission_denied");
  });

  it("passes audio+video constraints to getUserMedia (MVP contract)", async () => {
    let seen: MediaStreamConstraints | undefined;
    await acquireLocalMedia({
      getUserMedia: async (c) => {
        seen = c;
        return {} as MediaStream;
      },
    });
    expect(seen).toEqual({ audio: true, video: true });
  });
});

describe("stopTracks", () => {
  it("stops every track on a stream", () => {
    const stops: string[] = [];
    const makeTrack = (id: string) =>
      ({
        stop: () => stops.push(id),
      }) as unknown as MediaStreamTrack;
    const fakeStream = {
      getTracks: () => [makeTrack("a"), makeTrack("b")],
    } as unknown as MediaStream;
    stopTracks(fakeStream);
    expect(stops).toEqual(["a", "b"]);
  });

  it("is a no-op on null / undefined", () => {
    expect(() => stopTracks(null)).not.toThrow();
    expect(() => stopTracks(undefined)).not.toThrow();
  });

  it("swallows per-track stop() errors", () => {
    const fake = {
      getTracks: () => [
        {
          stop: () => {
            throw new Error("already stopped");
          },
        } as unknown as MediaStreamTrack,
      ],
    } as unknown as MediaStream;
    expect(() => stopTracks(fake)).not.toThrow();
  });
});

describe("sessionReducer — Phase 6 transitions", () => {
  const pending = (): SessionSlice =>
    run(initialSessionSlice, [
      { type: "JOIN_REQUESTED", roomId: ROOM },
      { type: "JOIN_ACCEPTED", message: joinAccepted(1) },
    ]);

  it("pending-media → waiting-for-peer on MEDIA_READY_SENT", () => {
    const next = sessionReducer(pending(), { type: "MEDIA_READY_SENT" });
    expect(next.session).toBe("waiting-for-peer");
    // Identity preserved — we don't wipe peerId / roomId.
    expect(next.selfPeerId).toBe(SELF_ID);
    expect(next.roomId).toBe(ROOM);
  });

  it("MEDIA_READY_SENT from idle is illegal", () => {
    expect(() =>
      sessionReducer(initialSessionSlice, { type: "MEDIA_READY_SENT" }),
    ).toThrow(IllegalSessionTransitionError);
  });

  it("pending-media → media-error on PARTICIPANT_RELEASED(media_failed)", () => {
    const next = sessionReducer(pending(), {
      type: "PARTICIPANT_RELEASED",
      message: participantReleased("media_failed"),
    });
    expect(next.session).toBe("media-error");
    // roomId is preserved so Retry knows which room to rejoin.
    expect(next.roomId).toBe(ROOM);
  });

  it("PARTICIPANT_RELEASED(disconnect) is a no-op from pending-media (Phase 6 scope)", () => {
    const start = pending();
    const next = sessionReducer(start, {
      type: "PARTICIPANT_RELEASED",
      message: participantReleased("disconnect"),
    });
    expect(next).toBe(start);
  });

  it("PARTICIPANT_RELEASED(media_failed) from a non-pending state throws", () => {
    expect(() =>
      sessionReducer(initialSessionSlice, {
        type: "PARTICIPANT_RELEASED",
        message: participantReleased("media_failed"),
      }),
    ).toThrow(IllegalSessionTransitionError);
  });

  it("media-error → joining on RETRY_REQUESTED (roomId preserved)", () => {
    const mediaError = run(initialSessionSlice, [
      { type: "JOIN_REQUESTED", roomId: ROOM },
      { type: "JOIN_ACCEPTED", message: joinAccepted(1) },
      {
        type: "PARTICIPANT_RELEASED",
        message: participantReleased("media_failed"),
      },
    ]);
    expect(mediaError.session).toBe("media-error");
    const next = sessionReducer(mediaError, { type: "RETRY_REQUESTED" });
    expect(next.session).toBe("joining");
    expect(next.roomId).toBe(ROOM);
    // Peer-identity fields are cleared — re-admission issues a fresh
    // peerId, and the reducer must not pretend we still hold the old one.
    expect(next.selfPeerId).toBeNull();
    expect(next.admissionOrder).toBeNull();
  });

  it("RETRY_REQUESTED from anywhere other than media-error throws", () => {
    expect(() =>
      sessionReducer(initialSessionSlice, { type: "RETRY_REQUESTED" }),
    ).toThrow(IllegalSessionTransitionError);
  });

  it("media-error → idle on LEAVE_REQUESTED", () => {
    const mediaError = run(initialSessionSlice, [
      { type: "JOIN_REQUESTED", roomId: ROOM },
      { type: "JOIN_ACCEPTED", message: joinAccepted(1) },
      {
        type: "PARTICIPANT_RELEASED",
        message: participantReleased("media_failed"),
      },
    ]);
    const next = sessionReducer(mediaError, { type: "LEAVE_REQUESTED" });
    expect(next.session).toBe("idle");
    expect(next.roomId).toBeNull();
    expect(next.selfPeerId).toBeNull();
  });
});
