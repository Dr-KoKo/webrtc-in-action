// MeshEventLogPanel (T036 + T060). Renders the bounded ring buffer of
// `MeshEventEntry` records with their scope tag, peer/pair badges, and
// short-form summary. FR-061: every `peer` / `pair` entry surfaces its
// peerId so the user can grep the log per-peer.
//
// M7 / T060 — when a `pairId` filter is set, only entries whose
// `pairId` matches are rendered. The filter is a simple substring
// match so users can paste partial IDs from the cost summary or
// remote tile (e.g. `1-2`).

import { useState } from "react";
import { useMeshState } from "../state";

export function MeshEventLogPanel() {
  const { eventLog } = useMeshState();
  const [pairFilter, setPairFilter] = useState("");
  const trimmed = pairFilter.trim();
  const filtered = trimmed
    ? eventLog.entries.filter((e) => e.pairId?.includes(trimmed) ?? false)
    : eventLog.entries;
  return (
    <section
      aria-labelledby="mesh-event-log-heading"
      className="mesh-event-log"
      data-testid="mesh-event-log"
    >
      <h2 id="mesh-event-log-heading">Event log</h2>
      <label className="mesh-event-log__filter">
        Filter by pairId:{" "}
        <input
          type="text"
          value={pairFilter}
          onChange={(e) => setPairFilter(e.target.value)}
          placeholder="e.g. 1-2"
          data-testid="mesh-event-log-pair-filter"
        />
      </label>
      <ul className="mesh-event-log__list">
        {filtered.map((entry) => (
          <li
            key={entry.id}
            className="mesh-event-log__row"
            data-testid="mesh-event-log-row"
            data-scope={entry.scope}
            data-peer-id={entry.peerId ?? ""}
            data-pair-id={entry.pairId ?? ""}
            data-event-type={entry.type}
          >
            <span className="mesh-event-log__ts">
              {new Date(entry.ts).toISOString().slice(11, 23)}
            </span>
            <span className="mesh-event-log__scope">[{entry.scope}]</span>
            {entry.peerId && (
              <span
                className="mesh-event-log__peer"
                data-testid="mesh-event-log-peer"
              >
                peer={short(entry.peerId)}
              </span>
            )}
            {entry.pairId && (
              <span className="mesh-event-log__pair">pair={entry.pairId}</span>
            )}
            <span className="mesh-event-log__type">{entry.type}</span>
            <span className="mesh-event-log__summary">{entry.summary}</span>
          </li>
        ))}
        {filtered.length === 0 && (
          <li className="mesh-event-log__empty">
            {trimmed
              ? `(no events matching pairId "${trimmed}")`
              : "(no events yet)"}
          </li>
        )}
      </ul>
    </section>
  );
}

function short(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}
