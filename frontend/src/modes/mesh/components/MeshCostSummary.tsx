// MeshCostSummary panel (T059). Renders the L14 surface — the O(N²)
// pair count for the room set against the O(N) cost shape carried by
// each local participant. Numbers update live as pairs change state.
//
// Driven purely by selector composition: `computeMeshCost` derives
// every cell from `Roster`, `LocalParticipant`, and the M7 PairsSlice;
// no separate count counter or cron is required. The panel is the
// primary visible verification surface for the FR-070 / NFR-007 /
// SC-008 acceptance.

import { useMeshState } from "../state";
import { computeMeshCost } from "../state/cost";

export function MeshCostSummary() {
  const { local, roster, pairs } = useMeshState();
  const cost = computeMeshCost({ local, roster, pairs });
  return (
    <section
      aria-labelledby="mesh-cost-summary-heading"
      className="mesh-cost-summary"
      data-testid="mesh-cost-summary"
    >
      <h2 id="mesh-cost-summary-heading">Mesh cost</h2>
      <dl className="mesh-cost-summary__list">
        <Row label="participants" value={cost.participants} testId="participants" />
        <Row
          label="local peers"
          value={cost.localPeerCount}
          testId="local-peers"
        />
        <Row
          label="local PCs"
          value={cost.localPeerConnectionCount}
          testId="local-pcs"
        />
        <Row
          label="local DataChannels"
          value={cost.localDataChannelCount}
          testId="local-dcs"
        />
        <Row
          label="outgoing audio senders"
          value={cost.outgoingAudioSenderCount}
          testId="outgoing-audio-senders"
        />
        <Row
          label="outgoing video senders"
          value={cost.outgoingVideoSenderCount}
          testId="outgoing-video-senders"
        />
        <Row
          label="room-wide pair total (N × (N − 1) / 2)"
          value={cost.totalRoomPairCount}
          testId="room-wide-pair-total"
        />
        <Row
          label="pairs connected"
          value={cost.connectedPairCount}
          testId="pairs-connected"
        />
        <Row
          label="pairs connecting"
          value={cost.connectingPairCount}
          testId="pairs-connecting"
        />
        <Row
          label="pairs failed"
          value={cost.failedPairCount}
          testId="pairs-failed"
        />
        <Row
          label="pairs pending"
          value={cost.pendingPairCount}
          testId="pairs-pending"
        />
      </dl>
    </section>
  );
}

interface RowProps {
  readonly label: string;
  readonly value: number;
  readonly testId: string;
}

function Row({ label, value, testId }: RowProps) {
  return (
    <div className="mesh-cost-summary__row">
      <dt>{label}</dt>
      <dd
        data-testid={`mesh-cost-summary-${testId}`}
        data-value={value}
      >
        {value}
      </dd>
    </div>
  );
}
