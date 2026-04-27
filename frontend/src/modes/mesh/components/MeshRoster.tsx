// MeshRoster (T036 + T041). Renders the local participant + remote
// roster as a list of presence pills. M4 places real entries; M5
// distinguishes the `released` presence by removing the entry from the
// remote roster (FR-013/FR-014). M6+ replaces the placeholder remote
// tiles with live `<video>` elements.

import { selectRosterAsArray } from "../state/roster";
import { useMeshState } from "../state";
import type { MeshLocalParticipant } from "../state/local";
import type { Presence } from "../signaling/schema";

const PRESENCE_LABEL: Record<Presence, string> = {
  joined: "joined",
  "media-ready": "media ready",
  connecting: "connecting",
  connected: "connected",
  failed: "failed",
  released: "released",
  left: "left",
};

function localPresenceLabel(local: MeshLocalParticipant): string {
  switch (local.fsm) {
    case "idle":
      return "idle";
    case "joining":
      return "joining";
    case "joined":
      return "joined (awaiting media)";
    case "acquiring-media":
      return "acquiring media…";
    case "media-ready":
      return "media ready";
    case "media-error":
      return "media error";
    case "released":
      return "released";
    case "in-room":
      return "in-room";
    case "leaving":
      return "leaving";
    case "left":
      return "left";
    case "failed":
      return "failed";
    case "signaling-error":
      return "signaling error";
    default:
      return local.fsm;
  }
}

export function MeshRoster() {
  const { local, roster } = useMeshState();
  const remotes = selectRosterAsArray(roster);
  const showLocal =
    local.fsm !== "idle" || local.peerId !== undefined;

  return (
    <section
      aria-labelledby="mesh-roster-heading"
      className="mesh-roster"
      data-testid="mesh-roster"
    >
      <h2 id="mesh-roster-heading">Roster</h2>
      <ul className="mesh-roster__list">
        {showLocal && (
          <li
            className="mesh-roster__item mesh-roster__item--local"
            data-testid="mesh-roster-self"
          >
            <span className="mesh-roster__index">
              #{local.admissionIndex ?? "—"}
            </span>
            <span className="mesh-roster__id">
              you ({local.peerId ? short(local.peerId) : "pending"})
            </span>
            <span
              className="mesh-roster__presence"
              data-presence={local.fsm}
              data-testid="mesh-roster-self-presence"
            >
              {localPresenceLabel(local)}
            </span>
            <span
              className="mesh-roster__media-placeholder"
              data-testid="mesh-roster-self-media"
            >
              {local.fsm === "media-ready" || local.fsm === "in-room"
                ? "media: live (preview)"
                : "media: pending"}
            </span>
          </li>
        )}
        {remotes.map((p) => (
          <li
            key={p.peerId}
            className="mesh-roster__item"
            data-testid={`mesh-roster-peer-${p.peerId}`}
            data-peer-id={p.peerId}
          >
            <span className="mesh-roster__index">#{p.admissionIndex}</span>
            <span className="mesh-roster__id">peer {short(p.peerId)}</span>
            <span
              className="mesh-roster__presence"
              data-presence={p.presence}
            >
              {PRESENCE_LABEL[p.presence]}
            </span>
            <span
              className="mesh-roster__media-placeholder"
              aria-hidden="true"
            >
              media: placeholder
            </span>
          </li>
        ))}
        {remotes.length === 0 && (
          <li
            className="mesh-roster__empty"
            data-testid="mesh-roster-empty"
          >
            (no remote peers yet)
          </li>
        )}
      </ul>
    </section>
  );
}

function short(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}
