// Top-level composition — reducer store + signaling + local media +
// peer-connection providers wrap the shared `<AppShell/>` layout.
//
// App does NOT open a WebSocket on render; the signaling provider
// merely constructs the client. The WS is opened when the user clicks
// Join (JoinForm). getUserMedia is invoked by the local-media
// provider on entry to `pending-media`, not on mount. The
// PeerConnectionProvider constructs the `RTCPeerConnection` only on
// receipt of `ready_for_offer` (contract §3.7; Phase 7 T051).

import { AppShell } from "./components/AppShell";
import { StoreProvider } from "./state";
import { SignalingProvider } from "./signaling/provider";
import { LocalMediaProvider } from "./webrtc/local-media-provider";
import { PeerConnectionProvider } from "./webrtc/peer-connection-provider";

export function App() {
  return (
    <StoreProvider>
      <SignalingProvider>
        <LocalMediaProvider>
          <PeerConnectionProvider>
            <AppShell />
          </PeerConnectionProvider>
        </LocalMediaProvider>
      </SignalingProvider>
    </StoreProvider>
  );
}
