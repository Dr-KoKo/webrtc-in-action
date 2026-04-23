// Top-level composition for Phase 5 — JoinForm + EventLogPanel +
// StateIndicators inside the reducer store and the signaling provider.
// App does NOT open a WebSocket on render; the signaling provider
// merely constructs the client. The WS is opened when the user clicks
// Join (JoinForm).

import { JoinForm } from "./components/JoinForm";
import { EventLogPanel } from "./components/EventLogPanel";
import { StateIndicators } from "./components/StateIndicators";
import { StoreProvider } from "./state";
import { SignalingProvider } from "./signaling/provider";

export function App() {
  return (
    <StoreProvider>
      <SignalingProvider>
        <main className="app">
          <header>
            <h1>webrtc-lab</h1>
            <p>1:1 WebRTC Learning Call — Phase 5 frontend baseline.</p>
          </header>
          <div className="app__grid">
            <JoinForm />
            <StateIndicators />
            <EventLogPanel />
          </div>
        </main>
      </SignalingProvider>
    </StoreProvider>
  );
}
