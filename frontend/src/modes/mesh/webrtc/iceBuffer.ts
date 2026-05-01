// Per-pair ICE buffer (T054). Each PairContext owns a buffer that
// holds inbound remote ICE candidates that arrive before
// `pc.setRemoteDescription` has resolved. Once the remote description
// is in place, the manager calls `drain` to flush the buffer in
// arrival order; subsequent candidates apply immediately.
//
// `null` is preserved as the canonical end-of-candidates sentinel
// (contract §3.12). `candidate: ""` is forbidden by the v2 schema
// and so MUST never reach this buffer; the schema validator rejects
// it before dispatch.

export type BufferedIceCandidate = RTCIceCandidateInit | null;

export interface IceBuffer {
  push(candidate: BufferedIceCandidate): void;
  drain(
    apply: (candidate: BufferedIceCandidate) => Promise<void> | void,
  ): Promise<void>;
  clear(): void;
  size(): number;
}

export function createIceBuffer(): IceBuffer {
  const queue: BufferedIceCandidate[] = [];
  return {
    push(candidate) {
      queue.push(candidate);
    },
    async drain(apply) {
      while (queue.length > 0) {
        const next = queue.shift()!;
        await apply(next);
      }
    },
    clear() {
      queue.length = 0;
    },
    size() {
      return queue.length;
    },
  };
}
