// ReconnectButton (M11 / T083, FR-026 / L15).
//
// Per-pair Reconnect control. Rendered inside `RemoteTile` ONLY when
// the pair's local `connectionState` is `failed`. Click triggers the
// PairManager's `reconnectPair(pairId)` which sends one
// `reconnect_pair { pairId, observedEpoch }` to the server (§3.14).
//
// Visibility (T083 DoD):
//   - shown when     connectionState === "failed"
//   - hidden when    state ∈ {"new","connecting","connected","closed"}
//                    or no PairContext exists for this peer
//   - hidden when    a reconnect request is already in-flight (button
//                    is rendered but disabled — text reads "Requesting…")
//
// The button never sends `reconnect_pair` for a healthy pair (the
// manager guards this) and never sends a global / room-wide reconnect.

import { useMemo } from "react";
import type { MeshPairView } from "../state/pairs";
import { useMeshPairManager } from "../signaling/provider";

export interface ReconnectButtonProps {
  readonly pair: MeshPairView;
}

export function ReconnectButton({ pair }: ReconnectButtonProps) {
  const manager = useMeshPairManager();
  const visible = pair.connectionState === "failed";
  const disabled = !manager || pair.reconnectRequested;
  const label = useMemo(() => {
    if (pair.reconnectRequested) return "Requesting…";
    return "Reconnect";
  }, [pair.reconnectRequested]);

  if (!visible) {
    return null;
  }

  return (
    <button
      type="button"
      className="mesh-reconnect-button"
      data-testid={`mesh-reconnect-button-${pair.pairId}`}
      data-pair-id={pair.pairId}
      data-pair-epoch={pair.pairEpoch}
      data-state={pair.connectionState}
      data-in-flight={pair.reconnectRequested ? "true" : "false"}
      disabled={disabled}
      aria-label={`Reconnect pair ${pair.pairId} (epoch ${pair.pairEpoch})`}
      onClick={() => manager?.reconnectPair(pair.pairId)}
    >
      {label}
    </button>
  );
}
