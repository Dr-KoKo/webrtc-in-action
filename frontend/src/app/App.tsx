// Top-level composition — the multi-mode route shell. Wraps the app
// in `<BrowserRouter>` and renders the persistent `ModeBadge` above
// the route outlet (FR-004). The route table and badge both derive
// from `./modes.tsx` so adding a new WebRTC mode is one entry there.

import { BrowserRouter } from "react-router-dom";
import { AppRoutes } from "./routes";
import { ModeBadge } from "./ModeBadge";

export function App() {
  return (
    <BrowserRouter>
      <ModeBadge />
      <AppRoutes />
    </BrowserRouter>
  );
}
