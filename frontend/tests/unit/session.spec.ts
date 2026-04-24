// Session reducer + event-log ring buffer unit tests (T043).

import { describe, expect, it } from "vitest";
import {
  initialSessionSlice,
  sessionReducer,
  IllegalSessionTransitionError,
  type SessionAction,
  type SessionSlice,
} from "../../src/state/session";
import type {
  JoinAcceptedMessage,
  JoinRejectedMessage,
  PeerPresenceChangedMessage,
} from "../../src/types/contract";
import {
  EVENT_LOG_MAX_ENTRIES,
  eventLogReducer,
  initialEventLogSlice,
  makeEventLogEntry,
  __resetEventLogSequence,
} from "../../src/state/event-log";

const ROOM = "demo";
const SELF_ID = "11111111-1111-4111-8111-111111111111";
const REMOTE_ID = "22222222-2222-4222-8222-222222222222";
const REQ_ID = "33333333-3333-4333-8333-333333333333";

function joinAccepted(order: 1 | 2, remoteReady = false): JoinAcceptedMessage {
  return {
    v: 1,
    type: "join_accepted",
    roomId: ROOM,
    requestId: REQ_ID,
    payload: {
      peerId: SELF_ID,
      admissionOrder: order,
      roomReadiness: remoteReady ? "paired" : "waiting_for_media",
      remotePeer: remoteReady
        ? { peerId: REMOTE_ID, mediaReadiness: "ready" }
        : null,
    },
  };
}

function joinRejected(
  result: "join_rejected_room_full" | "join_rejected_invalid_room",
): JoinRejectedMessage {
  return {
    v: 1,
    type: "join_rejected",
    roomId: ROOM,
    requestId: REQ_ID,
    payload: {
      result,
      reason: result === "join_rejected_room_full" ? "room_full" : "invalid_room_id",
      message:
        result === "join_rejected_room_full"
          ? "Room full."
          : "Invalid room id.",
    },
  };
}

function peerPresence(
  subject: string,
  presence: "pending-media" | "ready" | "in-call" | "left" | "released",
  reason:
    | "admitted"
    | "media_ready"
    | "media_failed"
    | "role_assigned"
    | "graceful_leave"
    | "disconnect"
    | "pending_released" = "admitted",
  order: 1 | 2 = 2,
): PeerPresenceChangedMessage {
  return {
    v: 1,
    type: "peer_presence_changed",
    roomId: ROOM,
    payload: {
      subjectPeerId: subject,
      admissionOrder: order,
      presence,
      reason,
    },
  };
}

function run(state: SessionSlice, actions: SessionAction[]): SessionSlice {
  return actions.reduce((s, a) => sessionReducer(s, a), state);
}

describe("sessionReducer", () => {
  it("idle → joining on JOIN_REQUESTED", () => {
    const next = sessionReducer(initialSessionSlice, {
      type: "JOIN_REQUESTED",
      roomId: ROOM,
    });
    expect(next.session).toBe("joining");
    expect(next.roomId).toBe(ROOM);
    expect(next.joinError).toBeNull();
  });

  it("joining → pending-media on JOIN_ACCEPTED (two-phase join: NOT waiting-for-peer)", () => {
    const joining = run(initialSessionSlice, [
      { type: "JOIN_REQUESTED", roomId: ROOM },
    ]);
    const next = sessionReducer(joining, {
      type: "JOIN_ACCEPTED",
      message: joinAccepted(1),
    });
    expect(next.session).toBe("pending-media");
    expect(next.selfPeerId).toBe(SELF_ID);
    expect(next.admissionOrder).toBe(1);
    // critically: we do NOT jump to waiting-for-peer — that only happens
    // post media_ready in Phase 6.
    expect(next.session).not.toBe("waiting-for-peer");
  });

  it("joining → idle on JOIN_REJECTED and stores visible error", () => {
    const joining = run(initialSessionSlice, [
      { type: "JOIN_REQUESTED", roomId: ROOM },
    ]);
    const next = sessionReducer(joining, {
      type: "JOIN_REJECTED",
      message: joinRejected("join_rejected_room_full"),
    });
    expect(next.session).toBe("idle");
    expect(next.joinError).toEqual({
      result: "join_rejected_room_full",
      message: "Room full.",
    });
  });

  it("pending-media → idle on explicit LEAVE_REQUESTED", () => {
    const pending = run(initialSessionSlice, [
      { type: "JOIN_REQUESTED", roomId: ROOM },
      { type: "JOIN_ACCEPTED", message: joinAccepted(1) },
    ]);
    expect(pending.session).toBe("pending-media");
    const next = sessionReducer(pending, { type: "LEAVE_REQUESTED" });
    expect(next.session).toBe("idle");
    expect(next.selfPeerId).toBeNull();
    expect(next.remoteParticipant).toBeNull();
  });

  it("joining → idle on LEAVE_REQUESTED (local connect/send failure path)", () => {
    // JoinForm dispatches LEAVE_REQUESTED when the WS connect or the
    // outbound join_room send fails locally — the reducer is still in
    // "joining" at that point because no server message has arrived.
    const joining = sessionReducer(initialSessionSlice, {
      type: "JOIN_REQUESTED",
      roomId: ROOM,
    });
    expect(joining.session).toBe("joining");
    const next = sessionReducer(joining, { type: "LEAVE_REQUESTED" });
    expect(next.session).toBe("idle");
  });

  it("does not expose a joining → waiting-for-peer path", () => {
    // Any direct attempt to produce waiting-for-peer from joining must
    // go through pending-media first. We assert this by showing that
    // JOIN_ACCEPTED (the only joining-consuming server message in the
    // Phase 5 reducer) yields pending-media, not waiting-for-peer.
    const joining = sessionReducer(initialSessionSlice, {
      type: "JOIN_REQUESTED",
      roomId: ROOM,
    });
    const next = sessionReducer(joining, {
      type: "JOIN_ACCEPTED",
      message: joinAccepted(1),
    });
    expect(next.session).not.toBe("waiting-for-peer");
  });

  it("peer_presence_changed updates remoteParticipant regardless of session state", () => {
    // From idle, the remote field should update.
    const afterPresenceIdle = sessionReducer(initialSessionSlice, {
      type: "PEER_PRESENCE_CHANGED",
      message: peerPresence(REMOTE_ID, "pending-media"),
    });
    expect(afterPresenceIdle.remoteParticipant?.peerId).toBe(REMOTE_ID);
    expect(afterPresenceIdle.remoteParticipant?.presence).toBe(
      "pending-media",
    );

    // From pending-media, the remote field should still update.
    const pending = run(initialSessionSlice, [
      { type: "JOIN_REQUESTED", roomId: ROOM },
      { type: "JOIN_ACCEPTED", message: joinAccepted(1) },
    ]);
    const next = sessionReducer(pending, {
      type: "PEER_PRESENCE_CHANGED",
      message: peerPresence(REMOTE_ID, "ready", "media_ready"),
    });
    expect(next.remoteParticipant?.presence).toBe("ready");
  });

  it("peer_presence_changed with presence=released clears remoteParticipant", () => {
    const pending = run(initialSessionSlice, [
      { type: "JOIN_REQUESTED", roomId: ROOM },
      { type: "JOIN_ACCEPTED", message: joinAccepted(1, true) },
    ]);
    expect(pending.remoteParticipant).not.toBeNull();
    const next = sessionReducer(pending, {
      type: "PEER_PRESENCE_CHANGED",
      message: peerPresence(REMOTE_ID, "released", "media_failed"),
    });
    expect(next.remoteParticipant).toBeNull();
  });

  it("illegal transition (JOIN_ACCEPTED from idle) throws", () => {
    expect(() =>
      sessionReducer(initialSessionSlice, {
        type: "JOIN_ACCEPTED",
        message: joinAccepted(1),
      }),
    ).toThrow(IllegalSessionTransitionError);
  });

  it("self-events (subjectPeerId == selfPeerId) are informational only", () => {
    const pending = run(initialSessionSlice, [
      { type: "JOIN_REQUESTED", roomId: ROOM },
      { type: "JOIN_ACCEPTED", message: joinAccepted(1) },
    ]);
    const next = sessionReducer(pending, {
      type: "PEER_PRESENCE_CHANGED",
      message: peerPresence(SELF_ID, "pending-media"),
    });
    expect(next).toStrictEqual(pending);
  });

  it("READY_FOR_OFFER transitions waiting-for-peer → connecting (Phase 7)", () => {
    const waiting = run(initialSessionSlice, [
      { type: "JOIN_REQUESTED", roomId: ROOM },
      { type: "JOIN_ACCEPTED", message: joinAccepted(1) },
      { type: "MEDIA_READY_SENT" },
    ]);
    expect(waiting.session).toBe("waiting-for-peer");
    const next = sessionReducer(waiting, { type: "READY_FOR_OFFER" });
    expect(next.session).toBe("connecting");
  });

  it("READY_FOR_OFFER from any state other than waiting-for-peer is a no-op", () => {
    // Contract §3.7: late duplicates must be ignored (logged as
    // `unexpected_ready_for_offer` at the provider layer). The
    // reducer no-ops so a stray action cannot drop state.
    const cases: Array<{ from: string; state: SessionSlice }> = [
      { from: "idle", state: initialSessionSlice },
      {
        from: "joining",
        state: run(initialSessionSlice, [
          { type: "JOIN_REQUESTED", roomId: ROOM },
        ]),
      },
      {
        from: "pending-media",
        state: run(initialSessionSlice, [
          { type: "JOIN_REQUESTED", roomId: ROOM },
          { type: "JOIN_ACCEPTED", message: joinAccepted(1) },
        ]),
      },
    ];
    for (const c of cases) {
      const next = sessionReducer(c.state, { type: "READY_FOR_OFFER" });
      expect(next, `from=${c.from}`).toBe(c.state);
    }
  });

  it("TRANSPORT_CHANGED updates the transport slice independently", () => {
    const next = sessionReducer(initialSessionSlice, {
      type: "TRANSPORT_CHANGED",
      transport: "connected",
    });
    expect(next.transport).toBe("connected");
    expect(next.session).toBe("idle");
  });
});

describe("event-log ring buffer", () => {
  it("evicts the oldest entry after MAX_ENTRIES+1 appends", () => {
    __resetEventLogSequence();
    let slice = initialEventLogSlice;
    const total = EVENT_LOG_MAX_ENTRIES + 1; // 501
    for (let i = 0; i < total; i++) {
      slice = eventLogReducer(slice, {
        type: "EVENT_LOG_APPEND",
        entry: makeEventLogEntry({
          type: "transport_changed",
          direction: "system",
          summary: `entry-${i}`,
          ts: 1000 + i,
        }),
      });
    }
    expect(slice.entries.length).toBe(EVENT_LOG_MAX_ENTRIES);
    // The very first entry (index 0) must have been evicted.
    expect(slice.entries[0]?.summary).toBe("entry-1");
    // The most recent must be the 501st.
    expect(slice.entries[slice.entries.length - 1]?.summary).toBe(
      `entry-${total - 1}`,
    );
  });

  it("entries are not mutated after insertion", () => {
    __resetEventLogSequence();
    const entry = makeEventLogEntry({
      type: "transport_changed",
      direction: "local",
      summary: "hello",
    });
    const slice = eventLogReducer(initialEventLogSlice, {
      type: "EVENT_LOG_APPEND",
      entry,
    });
    // The entry in the slice is the exact same instance we inserted.
    expect(slice.entries[0]).toBe(entry);
    // Top-level array changes between appends (immutable updates).
    const slice2 = eventLogReducer(slice, {
      type: "EVENT_LOG_APPEND",
      entry: makeEventLogEntry({
        type: "transport_changed",
        direction: "local",
        summary: "world",
      }),
    });
    expect(slice2.entries).not.toBe(slice.entries);
    expect(slice.entries.length).toBe(1);
  });
});
