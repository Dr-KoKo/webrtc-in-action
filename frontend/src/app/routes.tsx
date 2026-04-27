// Top-level route table — iterates the `MODES` registry from
// `./modes.tsx`. The wildcard fallback preserves the historical
// behavior of catching unknown paths into 001 so existing bookmarks
// (e.g., `?room=abc`) keep working.

import { Route, Routes } from "react-router-dom";
import { OneToOneApp } from "@/modes/one-to-one/route/OneToOneApp";
import { MODES } from "./modes";

export function AppRoutes() {
  return (
    <Routes>
      {MODES.map(({ id, path, component: Component }) => (
        <Route key={id} path={path} element={<Component />} />
      ))}
      <Route path="*" element={<OneToOneApp />} />
    </Routes>
  );
}
