// EventLogPanel rendering test (T040 verification).
//
// Asserts that entries are rendered as safe text: the summary string
// appears in the DOM verbatim even when it contains HTML-looking
// content (which proves no dangerouslySetInnerHTML is in play).

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { EventLogPanel } from "../../src/components/EventLogPanel";
import {
  StoreProvider,
  initialRootState,
  type RootState,
} from "../../src/state";
import { makeEventLogEntry } from "../../src/state/event-log";

function stateWithEntries(): RootState {
  return {
    ...initialRootState,
    eventLog: {
      entries: [
        makeEventLogEntry({
          type: "room_joined",
          direction: "system",
          summary: "room joined (peerId=aaaa…, admissionOrder=1)",
          ts: 1700000000000,
        }),
        makeEventLogEntry({
          type: "error_occurred",
          direction: "local",
          summary: "<img src=x>",
          ts: 1700000001000,
        }),
      ],
    },
  };
}

describe("EventLogPanel", () => {
  it("renders empty state when there are no entries", () => {
    render(
      <StoreProvider>
        <EventLogPanel />
      </StoreProvider>,
    );
    expect(screen.getByText(/No events yet/i)).toBeTruthy();
  });

  it("renders entries as safe text (no HTML injection)", () => {
    render(
      <StoreProvider initialState={stateWithEntries()}>
        <EventLogPanel />
      </StoreProvider>,
    );
    // Summary text is rendered verbatim, not interpreted as HTML.
    expect(
      screen.getByText("room joined (peerId=aaaa…, admissionOrder=1)"),
    ).toBeTruthy();
    expect(screen.getByText("<img src=x>")).toBeTruthy();
    // No live <img> was injected.
    expect(document.querySelector("img")).toBeNull();
    // Direction + type are visible too.
    expect(screen.getByText("[system]")).toBeTruthy();
    expect(screen.getByText("room_joined")).toBeTruthy();
  });
});
