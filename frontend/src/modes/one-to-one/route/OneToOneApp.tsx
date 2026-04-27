// 001 1:1 entry — the original App composition (provider tree wrapping
// AppShell) preserved byte-for-byte so the `/` route renders 001 mode
// exactly as it did before the 002 route shell landed.
//
// Mesh (002) introduces the BrowserRouter boundary; 001 itself is
// untouched. plan §6.4 explicitly preserves this composition.

import { AppShell } from "../components/AppShell";
import { StoreProvider } from "../state";
import { SignalingProvider } from "../signaling/provider";
import { LocalMediaProvider } from "../webrtc/local-media-provider";
import { PeerConnectionProvider } from "../webrtc/peer-connection-provider";
import { ScreenShareProvider } from "../webrtc/screen-share-provider";
import { CleanupProvider } from "../webrtc/cleanup";

export function OneToOneApp() {
  return (
    <StoreProvider>
      <SignalingProvider>
        <LocalMediaProvider>
          <PeerConnectionProvider>
            <ScreenShareProvider>
              <CleanupProvider>
                <AppShell />
              </CleanupProvider>
            </ScreenShareProvider>
          </PeerConnectionProvider>
        </LocalMediaProvider>
      </SignalingProvider>
    </StoreProvider>
  );
}
