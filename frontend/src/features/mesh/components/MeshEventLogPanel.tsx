// MeshEventLogPanel (T036). Renders the bounded ring buffer of
// `MeshEventEntry` records with their scope tag, peer/pair badges, and
// short-form summary. FR-061: every `peer` / `pair` entry surfaces its
// peerId so the user can grep the log per-peer.

import { useMeshState } from "../state";

export function MeshEventLogPanel() {
  const { eventLog } = useMeshState();
  return (
    <section
      aria-labelledby="mesh-event-log-heading"
      className="mesh-event-log"
      data-testid="mesh-event-log"
    >
      <h2 id="mesh-event-log-heading">Event log</h2>
      <ul className="mesh-event-log__list">
        {eventLog.entries.map((entry) => (
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
        {eventLog.entries.length === 0 && (
          <li className="mesh-event-log__empty">(no events yet)</li>
        )}
      </ul>
    </section>
  );
}

function short(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}
