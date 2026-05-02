// Event-log entry-type round-trip — pins the four Phase 11 additions
// (T078) against accidental removal / rename. `makeEventLogEntry`
// performs the only transform the slice applies on insert, so
// round-tripping through it is sufficient coverage — the reducer is
// already pinned in media-state.spec.ts / event-log-panel.spec.tsx.

import { describe, expect, it } from "vitest";
import {
  makeEventLogEntry,
  type EventLogEntryType,
} from "@/modes/one-to-one/state/event-log";

describe("EventLogEntryType — Phase 11 additions", () => {
  it("the four screen-share types round-trip through makeEventLogEntry", () => {
    const types: EventLogEntryType[] = [
      "screen_share_started",
      "screen_share_stopped",
      "screen_share_cancelled",
      "track_replaced",
    ];
    for (const type of types) {
      const entry = makeEventLogEntry({
        type,
        direction: "local",
        summary: `${type} test`,
      });
      expect(entry.type).toBe(type);
      expect(entry.direction).toBe("local");
      expect(entry.summary).toBe(`${type} test`);
      expect(typeof entry.id).toBe("string");
      expect(typeof entry.ts).toBe("number");
    }
  });

  it("screen_share_stopped carries `source` via the code field", () => {
    const entry = makeEventLogEntry({
      type: "screen_share_stopped",
      direction: "local",
      summary: "screen share stopped (source=browser)",
      code: "browser",
    });
    expect(entry.code).toBe("browser");
  });
});
