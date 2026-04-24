// Persistent state indicators (FR-022a / FR-022b).
//
// Phases active now: session + transport + room / peer identity (5-6),
// RTCPeerConnection getters (8). Remaining slots (local/remote media
// detail, screen share, chat channel) stay as placeholders until
// their phases land.

import { useRootState } from "../state";

const UNKNOWN = "—";

export function StateIndicators() {
  const { session, peerConnection } = useRootState();
  const remotePresence = session.remoteParticipant
    ? `${session.remoteParticipant.presence} (order ${session.remoteParticipant.admissionOrder})`
    : "none";
  const hasPc = peerConnection.hasConnection;
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

        {/* Phase-8 slots populated once `ready_for_offer` lands. */}
        <Indicator
          label="pc.connectionState"
          value={hasPc ? peerConnection.connectionState : UNKNOWN}
        />
        <Indicator
          label="pc.iceConnectionState"
          value={hasPc ? peerConnection.iceConnectionState : UNKNOWN}
        />
        <Indicator
          label="pc.iceGatheringState"
          value={hasPc ? peerConnection.iceGatheringState : UNKNOWN}
        />
        <Indicator
          label="pc.signalingState"
          value={hasPc ? peerConnection.signalingState : UNKNOWN}
        />

        {/* Future-phase slots. */}
        <Indicator label="local media" value={UNKNOWN} />
        <Indicator label="remote media" value={UNKNOWN} />
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
