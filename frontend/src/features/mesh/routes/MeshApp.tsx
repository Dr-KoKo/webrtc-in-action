// MeshApp — M1 placeholder. Reads `:roomId` from the URL and renders a
// minimal "Mesh mode (capacity 4) — placeholder" tile so the route
// shell is verifiable end-to-end without any signaling or media code.
//
// Replaced by the real mesh layout (JoinForm + MeshRoster +
// MeshEventLogPanel + RemoteTiles) in M4 (T036). No `RTCPeerConnection`,
// no `getUserMedia`, no WebSocket open in this milestone.

import { useParams } from "react-router-dom";

export function MeshApp() {
  const { roomId } = useParams<{ roomId: string }>();
  return (
    <main className="mesh-app" data-testid="mesh-app">
      <header>
        <h1>webrtc-lab — mesh mode</h1>
        <p data-testid="mesh-placeholder">
          Mesh mode (capacity 4) — placeholder. Room ID:{" "}
          <code data-testid="mesh-room-id">{roomId ?? ""}</code>
        </p>
      </header>
    </main>
  );
}
