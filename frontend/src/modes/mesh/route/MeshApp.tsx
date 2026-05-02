// MeshApp — the real mesh route layout (M4 + M5). Replaces the M1
// placeholder. Hosts the mesh-mode store + signaling client, and
// renders:
//
//   - JoinForm (T037): client-side room ID validation; sends `join_room`.
//   - MeshRoster (T036/T041): presence pills for self + remote peers.
//   - MeshEventLogPanel (T036): peer-scoped event entries.
//   - LocalPreview (M5 / T039): self-tile <video> after acquisition.
//   - MediaErrorBanner (M5 / T044): retry-able banner on permission denial.
//
// No `RTCPeerConnection`, no DataChannel, no offer/answer here — those
// land in M6+. The mesh hard boundary is enforced by the dispatcher,
// which logs (but does not act on) pair instructions before the local
// participant is `media-ready`.

import { useParams } from "react-router-dom";
import { MeshStoreProvider } from "../state";
import { MeshSignalingProvider, useMeshSignalingClient } from "../signaling/provider";
import { useMeshState } from "../state";
import { MeshJoinForm } from "../components/JoinForm";
import { MeshRoster } from "../components/MeshRoster";
import { MeshEventLogPanel } from "../components/MeshEventLogPanel";
import { MediaErrorBanner } from "../components/MediaErrorBanner";
import { LocalPreview } from "../components/LocalPreview";
import { MeshMediaController } from "../webrtc/mediaAcquisition";
import { RemoteTile } from "../components/RemoteTile";
import { MeshCostSummary } from "../components/MeshCostSummary";
import { MeshChat } from "../components/MeshChat";
import { MeshControls } from "../components/MeshControls";
import { selectRosterAsArray } from "../state/roster";
import { selectPairByRemotePeerId } from "../state/pairs";

function resolveMeshSignalingUrl(): string {
  const override = import.meta.env.VITE_MESH_SIGNALING_URL as
    | string
    | undefined;
  if (override && override.length > 0) return override;
  // Same convention as 001 — relative URL backed by Vite's WS proxy.
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws/mesh`;
}

export function MeshApp() {
  const { roomId } = useParams<{ roomId: string }>();
  return (
    <MeshStoreProvider>
      <MeshSignalingProvider>
        <MeshAppLayout roomId={roomId ?? ""} />
      </MeshSignalingProvider>
    </MeshStoreProvider>
  );
}

function MeshAppLayout({ roomId }: { roomId: string }) {
  const client = useMeshSignalingClient();
  const { local, roster, pairs } = useMeshState();
  const signalingUrl = resolveMeshSignalingUrl();
  const remotes = selectRosterAsArray(roster);
  return (
    <main className="mesh-app" data-testid="mesh-app">
      <header className="mesh-app__header">
        <h1>webrtc-lab — mesh mode</h1>
        <p>
          Mesh capacity: 4. Route room ID:{" "}
          <code data-testid="mesh-room-id">{roomId}</code>.
        </p>
        <p data-testid="mesh-self-summary">
          self: {local.peerId ?? "(unjoined)"}
          {typeof local.admissionIndex === "number"
            ? ` · #${local.admissionIndex}`
            : ""}{" "}
          · fsm={local.fsm} · transport={local.signalingTransport}
        </p>
      </header>
      <MediaErrorBanner />
      <MeshMediaController />
      <div className="mesh-app__body">
        <MeshJoinForm
          client={client}
          signalingUrl={signalingUrl}
          initialRoomId={roomId}
        />
        <LocalPreview />
        <MeshControls />
        <MeshRoster />
        <MeshCostSummary />
        <section
          className="mesh-app__remote-tiles"
          data-testid="mesh-remote-tiles"
        >
          <h2>Remote peers</h2>
          {remotes.length === 0 ? (
            <p data-testid="mesh-remote-tiles-empty">(no remote peers yet)</p>
          ) : (
            remotes.map((p) => (
              <RemoteTile
                key={p.peerId}
                peerId={p.peerId}
                admissionIndex={p.admissionIndex}
                presence={p.presence}
                pair={selectPairByRemotePeerId(pairs, p.peerId) ?? null}
                remoteMedia={p.remoteMedia}
              />
            ))
          )}
        </section>
        <MeshChat />
        <MeshEventLogPanel />
      </div>
    </main>
  );
}
