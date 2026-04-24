// Top-level composition — JoinForm + LocalVideo + EventLogPanel +
// StateIndicators inside the reducer store, the signaling provider,
// and (Phase 6) the local-media provider.
//
// App does NOT open a WebSocket on render; the signaling provider
// merely constructs the client. The WS is opened when the user clicks
// Join (JoinForm). getUserMedia is invoked by the local-media
// provider on entry to `pending-media`, not on mount.

import { JoinForm } from "./components/JoinForm";
import { EventLogPanel } from "./components/EventLogPanel";
import { LocalVideo } from "./components/LocalVideo";
import { StateIndicators } from "./components/StateIndicators";
import { StoreProvider } from "./state";
import { SignalingProvider } from "./signaling/provider";
import { LocalMediaProvider } from "./webrtc/local-media-provider";

export function App() {
  return (
    <StoreProvider>
      <SignalingProvider>
        <LocalMediaProvider>
          <main className="app">
            <header>
              <h1>webrtc-lab</h1>
              <p>
                1:1 WebRTC Learning Call — Phase 6: admission + local
                media.
              </p>
            </header>
            <div className="app__grid">
              <JoinForm />
              <LocalVideo />
              <StateIndicators />
              <EventLogPanel />
            </div>
          </main>
        </LocalMediaProvider>
      </SignalingProvider>
    </StoreProvider>
  );
}
