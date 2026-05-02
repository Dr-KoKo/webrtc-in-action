// IceBuffer — Phase 8 (T058, data-model §B.6, research §6).
//
// Trickle ICE candidates can arrive on the signaling channel BEFORE
// the local peer has called `setRemoteDescription`. Feeding them to
// `RTCPeerConnection.addIceCandidate` early fails silently or throws
// `InvalidStateError` depending on the browser, so we buffer them
// in arrival order and drain when the remote description resolves.
//
// Rules (from data-model §B.6):
// - On inbound `ice_candidate`:
//     remoteDescriptionSet === false → push to `pending` in arrival order
//     remoteDescriptionSet === true  → call `addIceCandidate` immediately
// - On `setRemoteDescription` resolve: flip `remoteDescriptionSet` to
//   true, drain `pending` in arrival order, clear `pending`.
// - On cleanup: clear `pending`; subsequent pushes are ignored.
//
// `candidate: null` (end-of-candidates) is a signaling-contract marker
// (§3.10), not a browser API input. It MUST NOT be forwarded to
// `addIceCandidate` — the buffer treats it as a no-op that callers may
// still record for observability.
//
// The buffer is pure — no React, no reducer, no WS. Tests can exercise
// it in isolation (T063).

/**
 * Minimal contract the buffer depends on. In production this is
 * `RTCPeerConnection`; in tests it's a fake that records calls.
 */
export interface IceBufferTarget {
  addIceCandidate(candidate: RTCIceCandidateInit): Promise<void>;
}

export interface IceBuffer {
  /**
   * `true` once `markRemoteDescriptionSet()` has been called and the
   * pending queue has been drained. Exposed so tests / the Learning
   * Inspector can surface the state.
   */
  readonly remoteDescriptionSet: boolean;
  /** Current queue length; 0 after drain, unchanged after close. */
  readonly pendingCount: number;
  /**
   * Intake point for remote candidates. `null` is the end-of-candidates
   * marker and MUST NOT be routed to `addIceCandidate` — the buffer
   * records it as a no-op. Returns the promise from
   * `addIceCandidate` when the candidate is applied immediately, or
   * `undefined` when the candidate was buffered / skipped.
   */
  add(candidate: RTCIceCandidateInit | null): Promise<void> | undefined;
  /**
   * Called when `setRemoteDescription` resolves. Flips
   * `remoteDescriptionSet` to true and drains every pending candidate
   * in insertion order. Awaits each `addIceCandidate` sequentially so
   * the browser sees a deterministic ordering.
   */
  markRemoteDescriptionSet(): Promise<void>;
  /**
   * Clears any pending candidates and locks the buffer closed. After
   * close, further `add` / `markRemoteDescriptionSet` calls become
   * no-ops. Idempotent.
   */
  close(): void;
}

export interface CreateIceBufferOptions {
  target: IceBufferTarget;
  /**
   * Optional observer — called once per buffered candidate that is
   * drained into the target. Lets the PC provider emit event-log
   * entries without re-reading the queue. Not called for candidates
   * that were applied immediately.
   */
  onDrain?: (candidate: RTCIceCandidateInit) => void;
  /**
   * Optional error hook — called if `addIceCandidate` rejects, either
   * during immediate application or drain. The buffer itself does not
   * throw: ICE is best-effort and one bad candidate must not stall
   * the rest. Defaults to a no-op.
   */
  onError?: (err: unknown, candidate: RTCIceCandidateInit) => void;
}

export function createIceBuffer(options: CreateIceBufferOptions): IceBuffer {
  const pending: RTCIceCandidateInit[] = [];
  let remoteDescriptionSet = false;
  let closed = false;

  async function applySafely(cand: RTCIceCandidateInit): Promise<void> {
    try {
      await options.target.addIceCandidate(cand);
    } catch (err) {
      options.onError?.(err, cand);
    }
  }

  return {
    get remoteDescriptionSet(): boolean {
      return remoteDescriptionSet;
    },
    get pendingCount(): number {
      return pending.length;
    },
    add(candidate): Promise<void> | undefined {
      if (closed) return undefined;
      if (candidate === null) {
        // End-of-candidates marker: never forwarded to
        // `addIceCandidate`. Callers may observe it via their own
        // event log; the buffer itself has nothing to do.
        return undefined;
      }
      if (!remoteDescriptionSet) {
        pending.push(candidate);
        return undefined;
      }
      return applySafely(candidate);
    },
    async markRemoteDescriptionSet(): Promise<void> {
      if (closed) return;
      if (remoteDescriptionSet) return; // idempotent
      remoteDescriptionSet = true;
      // Drain in arrival order. We snapshot-and-clear up front so a
      // candidate that arrives mid-drain (e.g., via the same WS frame
      // batch) is applied AFTER the pending queue via the
      // `remoteDescriptionSet === true` branch of `add`.
      const drain = pending.splice(0, pending.length);
      for (const cand of drain) {
        await applySafely(cand);
        options.onDrain?.(cand);
      }
    },
    close(): void {
      if (closed) return;
      closed = true;
      pending.length = 0;
      // remoteDescriptionSet intentionally NOT reset — a buffer is
      // single-use. The PC provider creates a fresh buffer per PC.
    },
  };
}
