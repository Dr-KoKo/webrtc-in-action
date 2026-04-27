// Event log panel — scrollable list of EventLogEntry (FR-020 / FR-021).
//
// Safe text rendering only. No dangerouslySetInnerHTML anywhere.

import { useRootState } from "../state";
import type { EventLogEntry } from "../state/event-log";

export function EventLogPanel() {
  const { eventLog } = useRootState();
  return (
    <section aria-labelledby="event-log-heading" className="event-log">
      <h2 id="event-log-heading">Event log</h2>
      {eventLog.entries.length === 0 ? (
        <p className="event-log__empty">No events yet.</p>
      ) : (
        <ul className="event-log__list" role="log" aria-live="polite">
          {eventLog.entries.map((entry) => (
            <EventLogRow key={entry.id} entry={entry} />
          ))}
        </ul>
      )}
    </section>
  );
}

function EventLogRow({ entry }: { entry: EventLogEntry }) {
  const time = formatTime(entry.ts);
  return (
    <li className={`event-log__row event-log__row--${entry.direction}`}>
      <time dateTime={new Date(entry.ts).toISOString()}>{time}</time>{" "}
      <span className="event-log__direction">[{entry.direction}]</span>{" "}
      <span className="event-log__type">{entry.type}</span>{" "}
      <span className="event-log__summary">{entry.summary}</span>
    </li>
  );
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}
