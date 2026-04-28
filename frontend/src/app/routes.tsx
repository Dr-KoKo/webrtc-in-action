// Top-level route table — iterates the `MODES` registry from
// `./modes.tsx`. The wildcard fallback resolves through the registry
// + `FALLBACK_MODE_ID` so this file does NOT directly import any
// mode entry component. Boundary rule: `modes.tsx` is the only file
// in `app/` allowed to import from `@/modes/*` (enforced by
// `scripts/audit-boundaries.sh`).

import { Route, Routes } from "react-router-dom";
import { FALLBACK_MODE_ID, MODES } from "./modes";

export function AppRoutes() {
  const fallback =
    MODES.find((m) => m.id === FALLBACK_MODE_ID) ?? MODES[0];
  if (!fallback) {
    throw new Error("MODES registry is empty");
  }
  const Fallback = fallback.component;
  return (
    <Routes>
      {MODES.map(({ id, path, component: Component }) => (
        <Route key={id} path={path} element={<Component />} />
      ))}
      <Route path="*" element={<Fallback />} />
    </Routes>
  );
}
