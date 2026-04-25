// Top-level composition — the route shell. Wraps the application in a
// `<BrowserRouter>` and renders the persistent `ModeBadge` above the
// route outlet (FR-004). The `/` route preserves the 001 entry
// (`OneToOneApp`) byte-for-byte; `/mesh/:roomId` renders the 002 mesh
// shell. Plan §6 + §6.4 — 001 modules untouched, route boundary is the
// only new top-level surface.

import { BrowserRouter } from "react-router-dom";
import { AppRoutes } from "./routes";
import { ModeBadge } from "./routes/modeBadge";

export function App() {
  return (
    <BrowserRouter>
      <ModeBadge />
      <AppRoutes />
    </BrowserRouter>
  );
}
