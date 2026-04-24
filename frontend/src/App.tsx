// Top-level composition — reducer store + signaling provider +
// local-media provider wrap the shared `<AppShell/>` layout.
//
// App does NOT open a WebSocket on render; the signaling provider
// merely constructs the client. The WS is opened when the user clicks
// Join (JoinForm). getUserMedia is invoked by the local-media
// provider on entry to `pending-media`, not on mount.

import { AppShell } from "./components/AppShell";
import { StoreProvider } from "./state";
import { SignalingProvider } from "./signaling/provider";
import { LocalMediaProvider } from "./webrtc/local-media-provider";

export function App() {
  return (
    <StoreProvider>
      <SignalingProvider>
        <LocalMediaProvider>
          <AppShell />
        </LocalMediaProvider>
      </SignalingProvider>
    </StoreProvider>
  );
}
