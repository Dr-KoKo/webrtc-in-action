// IceBuffer unit tests (T063, Phase 8).
//
// Locks data-model §B.6 rules:
//   a) Candidates arriving before setRemoteDescription are buffered.
//   b) markRemoteDescriptionSet drains pending in insertion order.
//   c) close() clears the queue and makes subsequent ops no-ops.
//   d) candidate: null is a no-op (never passed to addIceCandidate).
// Plus two reasonable invariants we want pinned as regressions:
//   e) Candidates that arrive AFTER remote description is set go
//      straight to addIceCandidate, not through the queue.
//   f) addIceCandidate rejections on one candidate do not stall drain.

import { describe, expect, it, vi } from "vitest";
import {
  createIceBuffer,
  type IceBuffer,
  type IceBufferTarget,
} from "../../src/webrtc/ice-buffer";

interface FakeTarget extends IceBufferTarget {
  calls: RTCIceCandidateInit[];
  rejects: Set<RTCIceCandidateInit>;
}

function makeTarget(): FakeTarget {
  const target = {
    calls: [] as RTCIceCandidateInit[],
    rejects: new Set<RTCIceCandidateInit>(),
    async addIceCandidate(c: RTCIceCandidateInit): Promise<void> {
      target.calls.push(c);
      if (target.rejects.has(c)) {
        throw new Error("synthetic addIceCandidate failure");
      }
    },
  };
  return target;
}

function mkCand(tag: string): RTCIceCandidateInit {
  // Real candidates are opaque strings; the unit-level test just needs
  // unique identity so we can assert order and count.
  return { candidate: `candidate:${tag} 1 UDP 100 1.2.3.4 5678 typ host`, sdpMid: "0" };
}

describe("createIceBuffer", () => {
  it("buffers candidates received before the remote description is set", () => {
    const target = makeTarget();
    const buf: IceBuffer = createIceBuffer({ target });

    const a = mkCand("A");
    const b = mkCand("B");
    buf.add(a);
    buf.add(b);

    // Nothing delivered yet — both are waiting in the buffer.
    expect(target.calls).toEqual([]);
    expect(buf.pendingCount).toBe(2);
    expect(buf.remoteDescriptionSet).toBe(false);
  });

  it("drains buffered candidates in insertion order on markRemoteDescriptionSet", async () => {
    const target = makeTarget();
    const onDrain = vi.fn();
    const buf = createIceBuffer({ target, onDrain });

    const a = mkCand("A");
    const b = mkCand("B");
    const c = mkCand("C");
    buf.add(a);
    buf.add(b);
    buf.add(c);

    await buf.markRemoteDescriptionSet();

    expect(target.calls).toEqual([a, b, c]);
    expect(buf.pendingCount).toBe(0);
    expect(buf.remoteDescriptionSet).toBe(true);
    // onDrain is invoked exactly once per candidate that was pending
    // at drain time — straight-through candidates (post-SRD) do NOT
    // trigger it.
    expect(onDrain).toHaveBeenCalledTimes(3);
    expect(onDrain.mock.calls.map((c) => c[0])).toEqual([a, b, c]);
  });

  it("applies candidates immediately once remote description is set", async () => {
    const target = makeTarget();
    const onDrain = vi.fn();
    const buf = createIceBuffer({ target, onDrain });

    await buf.markRemoteDescriptionSet();
    const a = mkCand("A");

    // `add` returns a promise in this branch (the addIceCandidate call).
    await buf.add(a);

    expect(target.calls).toEqual([a]);
    // Straight-through path must NOT invoke onDrain — there was nothing
    // to drain.
    expect(onDrain).not.toHaveBeenCalled();
  });

  it("treats candidate: null as a no-op (never forwarded)", async () => {
    const target = makeTarget();
    const buf = createIceBuffer({ target });

    // Before SRD.
    const before = buf.add(null);
    expect(before).toBeUndefined();
    expect(target.calls).toEqual([]);
    expect(buf.pendingCount).toBe(0);

    // After SRD.
    await buf.markRemoteDescriptionSet();
    const after = buf.add(null);
    expect(after).toBeUndefined();
    expect(target.calls).toEqual([]);
  });

  it("close() clears pending and makes subsequent operations no-ops", async () => {
    const target = makeTarget();
    const buf = createIceBuffer({ target });

    buf.add(mkCand("A"));
    buf.add(mkCand("B"));
    expect(buf.pendingCount).toBe(2);

    buf.close();

    expect(buf.pendingCount).toBe(0);
    // Subsequent adds are ignored.
    const late = buf.add(mkCand("C"));
    expect(late).toBeUndefined();
    expect(target.calls).toEqual([]);
    // And mark is a no-op too.
    await buf.markRemoteDescriptionSet();
    expect(target.calls).toEqual([]);

    // close is idempotent.
    buf.close();
    expect(buf.pendingCount).toBe(0);
  });

  it("markRemoteDescriptionSet is idempotent (does not re-drain)", async () => {
    const target = makeTarget();
    const buf = createIceBuffer({ target });

    buf.add(mkCand("A"));
    await buf.markRemoteDescriptionSet();
    expect(target.calls.length).toBe(1);

    // Second call is a no-op — does not re-invoke addIceCandidate.
    await buf.markRemoteDescriptionSet();
    expect(target.calls.length).toBe(1);
  });

  it("an addIceCandidate rejection on one candidate does not stall the rest", async () => {
    const target = makeTarget();
    const onError = vi.fn();
    const buf = createIceBuffer({ target, onError });

    const a = mkCand("A");
    const bad = mkCand("BAD");
    const c = mkCand("C");
    target.rejects.add(bad);

    buf.add(a);
    buf.add(bad);
    buf.add(c);
    await buf.markRemoteDescriptionSet();

    // All three were attempted in order — the error handler was
    // invoked for `bad` but the drain continued.
    expect(target.calls).toEqual([a, bad, c]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[1]).toBe(bad);
    expect(buf.pendingCount).toBe(0);
  });
});
