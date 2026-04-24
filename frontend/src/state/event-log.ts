// Event-log slice — append-only bounded ring buffer (data-model §B.7).
//
// Per NFR-006 / constitution Principle VIII: entries are safe text only;
// never store raw SDP, ICE candidate strings, or secrets. The ring
// buffer drops the oldest entry after the 500th; entries are immutable
// once inserted (the slice returns a brand-new array on append).

export const EVENT_LOG_MAX_ENTRIES = 500;

export type EventDirection = "local" | "remote" | "system";
export type EventTransport = "signaling" | "datachannel";

export type EventLogEntryType =
  // app-originated UI / transport events
  | "room_joined"
  | "error_occurred"
  | "peer_presence_changed"
  | "transport_changed"
  | "join_room_sent"
  | "leave_requested"
  | "retry_requested"
  | "media_acquire_started"
  | "media_ready_sent"
  | "media_failed_sent"
  // future-phase canonical inbound message pass-throughs — the
  // dispatcher's fallback branch emits msg.type verbatim while the
  // phase-specific handler is still pending.
  | "media_ready"
  | "media_failed"
  | "ready_for_offer"
  | "offer"
  | "answer"
  | "ice_candidate"
  | "media_state"
  | "peer_left"
  | "participant_released"
  | "leave_room";

export interface EventLogEntry {
  readonly id: string;
  readonly ts: number;
  readonly type: EventLogEntryType;
  readonly direction: EventDirection;
  readonly summary: string;
  readonly transport?: EventTransport;
  readonly reason?: string;
  readonly code?: string;
}

export interface EventLogSlice {
  readonly entries: readonly EventLogEntry[];
}

export const initialEventLogSlice: EventLogSlice = {
  entries: [],
};

export type EventLogAction = {
  type: "EVENT_LOG_APPEND";
  entry: EventLogEntry;
};

let eventLogSequence = 0;
// Deterministic id: timestamp + monotonic counter. Good enough for React
// keys and debugging. Does not leak entropy or collide in tests because
// we reset the counter in unit tests via `__resetEventLogSequence`.
export function makeEventLogEntry(
  init: Omit<EventLogEntry, "id" | "ts"> & { ts?: number; id?: string },
): EventLogEntry {
  eventLogSequence += 1;
  const entry: EventLogEntry = {
    id: init.id ?? `evt-${Date.now().toString(36)}-${eventLogSequence}`,
    ts: init.ts ?? Date.now(),
    type: init.type,
    direction: init.direction,
    summary: init.summary,
    ...(init.transport !== undefined ? { transport: init.transport } : {}),
    ...(init.reason !== undefined ? { reason: init.reason } : {}),
    ...(init.code !== undefined ? { code: init.code } : {}),
  };
  return entry;
}

export function __resetEventLogSequence(): void {
  eventLogSequence = 0;
}

export function eventLogReducer(
  state: EventLogSlice,
  action: EventLogAction,
): EventLogSlice {
  switch (action.type) {
    case "EVENT_LOG_APPEND": {
      const next = [...state.entries, action.entry];
      if (next.length > EVENT_LOG_MAX_ENTRIES) {
        next.splice(0, next.length - EVENT_LOG_MAX_ENTRIES);
      }
      return { entries: next };
    }
    default:
      return state;
  }
}
