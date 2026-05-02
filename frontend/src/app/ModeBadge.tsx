// Persistent mode badge — FR-004 mode-mode UI indicator. Rendered
// above the route outlet so it stays visible across navigation
// between modes. Reads the active mode from the registry; falls back
// to FALLBACK_MODE_ID when no mode path matches (mirrors the route
// table's wildcard fallback).

import { matchPath, useLocation } from "react-router-dom";
import { FALLBACK_MODE_ID, MODES } from "./modes";

export function ModeBadge() {
  const { pathname } = useLocation();
  const active =
    MODES.find((m) => matchPath(m.path, pathname)) ??
    MODES.find((m) => m.id === FALLBACK_MODE_ID)!;
  return (
    <div
      data-testid="mode-badge"
      data-mode={active.id}
      className="mode-badge"
    >
      {active.label}
    </div>
  );
}
