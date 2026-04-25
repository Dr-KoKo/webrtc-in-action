// Persistent mode badge — FR-004 mesh-mode UI indicator. Rendered above
// the route outlet so it stays visible across navigation between `/`
// (1:1 mode) and `/mesh/:roomId` (mesh mode).

import { useLocation } from "react-router-dom";

export function ModeBadge() {
  const { pathname } = useLocation();
  const isMesh = pathname.startsWith("/mesh");
  const label = isMesh ? "Mesh mode (capacity 4)" : "1:1 mode";
  return (
    <div
      data-testid="mode-badge"
      data-mode={isMesh ? "mesh" : "one-to-one"}
      className="mode-badge"
    >
      {label}
    </div>
  );
}
