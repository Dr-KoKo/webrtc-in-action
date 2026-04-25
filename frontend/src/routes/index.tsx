// Top-level route table for the webrtc-lab frontend.
//
// `/` renders the preserved 001 1:1 entry (`OneToOneApp` — same provider
// tree as the pre-002 `App.tsx`); `/mesh/:roomId` renders the 002 mesh
// shell. Anything else is treated as 001 by default so existing
// bookmarks (e.g., `?room=abc` query strings) keep working.

import { Route, Routes } from "react-router-dom";
import { OneToOneApp } from "./OneToOneApp";
import { MeshApp } from "../features/mesh/routes/MeshApp";

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/mesh/:roomId" element={<MeshApp />} />
      <Route path="*" element={<OneToOneApp />} />
    </Routes>
  );
}
