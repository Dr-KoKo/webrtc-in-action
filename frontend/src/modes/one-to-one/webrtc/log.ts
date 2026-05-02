// Per-mode event-log helper (Phase C1 of the frontend rings refactor).
//
// Collapses the ~80 inline `dispatch({ type: "EVENT_LOG_APPEND", entry:
// makeEventLogEntry({...}) })` callsites in the 1:1 mode down to one
// `log.<channel>({...})` call. The on-screen event log entries
// produced are byte-for-byte identical — `transport` is filled in by
// the helper, every other EventLogEntry field still flows through
// the caller.
//
// Two construction modes:
//
//   makeLog((entry) => store.getState().appendEvent(entry))
//     — for non-React verbs (Phase D1+), where the caller holds a
//       store API directly.
//
//   useLog()
//     — React-hook form, internally builds the helper from
//       useDispatch(). Used by components and the legacy provider
//       tower until Phase E1 collapses them.

import { useMemo } from "react";
import {
  makeEventLogEntry,
  type EventDirection,
  type EventLogEntry,
  type EventTransport,
} from "../state/event-log";
import { useDispatch } from "../state";

export type LogPayload = Omit<EventLogEntry, "id" | "ts" | "transport">;

export interface ErrorLogOptions {
  code: string;
  message: string;
  direction?: EventDirection;
  transport?: EventTransport;
}

export interface OneToOneLog {
  signaling(payload: LogPayload): void;
  datachannel(payload: LogPayload): void;
  system(payload: LogPayload): void;
  error(opts: ErrorLogOptions): void;
}

export function makeLog(append: (entry: EventLogEntry) => void): OneToOneLog {
  const emit = (payload: LogPayload, transport?: EventTransport): void =>
    append(
      makeEventLogEntry({
        ...payload,
        ...(transport !== undefined ? { transport } : {}),
      }),
    );
  return {
    signaling: (payload) => emit(payload, "signaling"),
    datachannel: (payload) => emit(payload, "datachannel"),
    system: (payload) => emit(payload),
    error: ({ code, message, direction, transport }) =>
      emit(
        {
          type: "error_occurred",
          direction: direction ?? "system",
          summary: `error occurred: ${code}`,
          code,
          reason: message.slice(0, 120),
        },
        transport ?? "signaling",
      ),
  };
}

export function useLog(): OneToOneLog {
  const dispatch = useDispatch();
  return useMemo(
    () =>
      makeLog((entry) => dispatch({ type: "EVENT_LOG_APPEND", entry })),
    [dispatch],
  );
}
