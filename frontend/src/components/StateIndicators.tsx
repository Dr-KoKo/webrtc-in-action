// Persistent state indicators (FR-022a / FR-022b).
//
// Phase 5 wires only the indicators whose state slices exist this
// phase (session, signaling transport, room id, self peer id, remote
// peer presence). The remaining indicators (local/remote media,
// RTCPeerConnection state, data channel, screen share) are rendered
// with a placeholder value so future phases can fill them in without
// rearranging the layout.

import { useRootState } from "../state";

const UNKNOWN = "—";

export function StateIndicators() {
  const { session } = useRootState();
  const remotePresence = session.remoteParticipant
    ? `${session.remoteParticipant.presence} (order ${session.remoteParticipant.admissionOrder})`
    : "none";
  return (
    <section
      aria-labelledby="state-indicators-heading"
      className="state-indicators"
    >
      <h2 id="state-indicators-heading">State</h2>
      <dl className="state-indicators__list">
        <Indicator label="session" value={session.session} />
        <Indicator label="signaling transport" value={session.transport} />
        <Indicator label="room id" value={session.roomId ?? UNKNOWN} />
        <Indicator
          label="self peer id"
          value={session.selfPeerId ?? UNKNOWN}
        />
        <Indicator label="remote peer presence" value={remotePresence} />

        {/* Future-phase slots — rendered as '—' until their slices land. */}
        <Indicator label="local media" value={UNKNOWN} />
        <Indicator label="remote media" value={UNKNOWN} />
        <Indicator label="pc.connectionState" value={UNKNOWN} />
        <Indicator label="pc.iceConnectionState" value={UNKNOWN} />
        <Indicator label="pc.signalingState" value={UNKNOWN} />
        <Indicator label="screen share" value={UNKNOWN} />
        <Indicator label="chat channel" value={UNKNOWN} />
      </dl>
    </section>
  );
}

function Indicator({ label, value }: { label: string; value: string }) {
  return (
    <div className="state-indicators__item">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
