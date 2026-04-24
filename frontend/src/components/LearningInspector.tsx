// Learning Inspector v1 panel — Phase 8 (T062, FR-030).
//
// Renders derived summaries from `PeerConnectionProvider.inspector`.
// **This component NEVER reads raw SDP or raw candidate strings.** All
// data lives as counters + booleans computed inside
// `src/webrtc/learning-inspector.ts` (NFR-006 / Principle VIII).

import { usePeerConnection } from "../webrtc/peer-connection-provider";
import type { LearningInspectorSnapshot } from "../webrtc/learning-inspector";

const UNKNOWN = "—";

export function LearningInspector() {
  const { inspector } = usePeerConnection();

  return (
    <section
      aria-labelledby="learning-inspector-heading"
      className="learning-inspector"
    >
      <h2 id="learning-inspector-heading">Learning Inspector</h2>
      <div className="learning-inspector__groups">
        <IceServersGroup snapshot={inspector} />
        <CandidatesGroup snapshot={inspector} />
        <SdpGroup label="Local SDP" sdp={inspector.local} />
        <SdpGroup label="Remote SDP" sdp={inspector.remote} />
      </div>
    </section>
  );
}

function IceServersGroup({
  snapshot,
}: {
  snapshot: LearningInspectorSnapshot;
}) {
  const { stunConfigured, turnConfigured } = snapshot.configured;
  const { srflxCandidates, relayCandidates } = snapshot.observed;
  return (
    <div className="learning-inspector__group">
      <h3>ICE servers</h3>
      <dl>
        <Row label="STUN configured" value={yesNo(stunConfigured)} />
        <Row
          label="srflx observed"
          value={yesNo(srflxCandidates > 0)}
          {...(srflxCandidates > 0 ? { note: `(${srflxCandidates})` } : {})}
        />
        <Row label="TURN configured" value={yesNo(turnConfigured)} />
        <Row
          label="relay observed"
          value={yesNo(relayCandidates > 0)}
          {...(relayCandidates > 0 ? { note: `(${relayCandidates})` } : {})}
        />
      </dl>
    </div>
  );
}

function CandidatesGroup({
  snapshot,
}: {
  snapshot: LearningInspectorSnapshot;
}) {
  const o = snapshot.observed;
  return (
    <div className="learning-inspector__group">
      <h3>Candidates observed</h3>
      <dl>
        <Row label="host" value={String(o.hostCandidates)} />
        <Row label="srflx" value={String(o.srflxCandidates)} />
        <Row label="prflx" value={String(o.prflxCandidates)} />
        <Row label="relay" value={String(o.relayCandidates)} />
        <Row
          label="end-of-candidates (local)"
          value={yesNo(o.endOfLocalCandidates)}
        />
        <Row
          label="end-of-candidates (remote)"
          value={yesNo(o.endOfRemoteCandidates)}
        />
      </dl>
    </div>
  );
}

function SdpGroup({
  label,
  sdp,
}: {
  label: string;
  sdp: LearningInspectorSnapshot["local"];
}) {
  return (
    <div className="learning-inspector__group">
      <h3>{label}</h3>
      {sdp ? (
        <dl>
          <Row label="kind" value={sdp.kind} />
          <Row label="m=audio" value={yesNo(sdp.mSections.audio)} />
          <Row label="m=video" value={yesNo(sdp.mSections.video)} />
          <Row label="m=application" value={yesNo(sdp.mSections.data)} />
          <Row label="size (bytes)" value={String(sdp.sdpBytes)} />
        </dl>
      ) : (
        <p className="learning-inspector__placeholder">
          Populated after the SDP exchange.
        </p>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div className="learning-inspector__row">
      <dt>{label}</dt>
      <dd>
        {value || UNKNOWN}
        {note ? <span className="learning-inspector__note"> {note}</span> : null}
      </dd>
    </div>
  );
}

function yesNo(b: boolean): string {
  return b ? "yes" : "no";
}
