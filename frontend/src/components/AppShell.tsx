// AppShell — visible UI layout shared by the production entry
// (`src/main.tsx`) and the e2e test-only entry
// (`tests/e2e/test-app/main.tsx`).
//
// The provider tree (StoreProvider → SignalingProvider →
// LocalMediaProvider) lives in the entry points, not here; both
// entries then render <AppShell/> so the visible DOM is identical.
// Phase 7+ will add siblings (RemoteVideo, LearningInspector, chat
// panel, media-controls bar) to this single file.

import { JoinForm } from "./JoinForm";
import { EventLogPanel } from "./EventLogPanel";
import { LocalVideo } from "./LocalVideo";
import { RemoteVideo } from "./RemoteVideo";
import { StateIndicators } from "./StateIndicators";
import { LearningInspector } from "./LearningInspector";

export function AppShell() {
  return (
    <main className="app">
      <header>
        <h1>webrtc-lab</h1>
        <p>
          1:1 WebRTC Learning Call — Phase 8: trickle ICE + remote
          media + Learning Inspector v1.
        </p>
      </header>
      <div className="app__grid">
        <JoinForm />
        <LocalVideo />
        <RemoteVideo />
        <StateIndicators />
        <LearningInspector />
        <EventLogPanel />
      </div>
    </main>
  );
}
