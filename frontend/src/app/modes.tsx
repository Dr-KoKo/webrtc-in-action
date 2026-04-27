// Mode registry — the single source of truth for which WebRTC
// implementations the app exposes. Each entry pairs a route path
// with a mounted component, a UI label, and the signaling-endpoint
// path that mode talks to.
//
// Adding a new mode (SFU, recording, …):
//   1. Create `src/modes/<id>/route/<Name>App.tsx`.
//   2. Append one entry to `MODES` below.
//   3. Add the same id to the `for m in ...` loops in
//      `scripts/audit-boundaries.sh` so the isolation gate covers it.
//   4. Land the matching `/ws/<id>` server endpoint in
//      `signaling/internal/modes/<id>/`.
//
// Boundary rule: this is the ONE place in `app/` allowed to import
// mode entry components. `routes.tsx` and `ModeBadge.tsx` consume
// this registry as data.

import type { ComponentType } from "react";
import { OneToOneApp } from "@/modes/one-to-one/route/OneToOneApp";
import { MeshApp } from "@/modes/mesh/route/MeshApp";

export interface ModeEntry {
  readonly id: string;
  readonly label: string;
  readonly path: string; // React Router pattern
  readonly component: ComponentType<Record<string, never>>;
  readonly signalingPath: string;
}

export const MODES: readonly ModeEntry[] = [
  {
    id: "one-to-one",
    label: "1:1 mode",
    path: "/",
    component: OneToOneApp,
    signalingPath: "/ws",
  },
  {
    id: "mesh",
    label: "Mesh mode (capacity 4)",
    path: "/mesh/:roomId",
    component: MeshApp,
    signalingPath: "/ws/mesh",
  },
] as const;

// The id of the mode that handles every URL not matched by another
// mode's `path`. Mirrors the current router's `<Route path="*"
// element={<OneToOneApp />} />` wildcard fallback.
export const FALLBACK_MODE_ID: ModeEntry["id"] = "one-to-one";
