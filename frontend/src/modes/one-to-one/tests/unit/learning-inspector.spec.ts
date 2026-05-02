// Learning Inspector pure-summarizer unit tests (T062, Phase 8).
//
// Pins the contract that `src/webrtc/learning-inspector.ts` is a
// deterministic, side-effect-free classifier: the outputs are the only
// things rendered in the UI, so a bug here is directly visible to the
// user AND — critically — can mask a regression that leaks raw SDP or
// candidate bodies. Tests assert the OUTPUT SHAPE, not the input body
// round-tripping (summaries only, per NFR-006 / Principle VIII).

import { describe, expect, it } from "vitest";
import {
  summarizeCandidate,
  summarizeIceServers,
  summarizeSdp,
} from "@/modes/one-to-one/webrtc/learning-inspector";

describe("summarizeSdp", () => {
  it("detects audio + video + application m-sections in an offer", () => {
    const sdp = [
      "v=0",
      "o=- 1 1 IN IP4 127.0.0.1",
      "s=-",
      "m=audio 9 UDP/TLS/RTP/SAVPF 111",
      "m=video 9 UDP/TLS/RTP/SAVPF 96",
      "m=application 9 DTLS/SCTP 5000",
      "",
    ].join("\r\n");
    const summary = summarizeSdp({ type: "offer", sdp });
    expect(summary.kind).toBe("offer");
    expect(summary.mSections).toEqual({ audio: true, video: true, data: true });
    expect(summary.mSectionCounts).toEqual({ audio: 1, video: 1, data: 1 });
    expect(summary.sdpBytes).toBe(sdp.length);
  });

  it("counts duplicate m-sections without flipping booleans", () => {
    // Rare but legal — simulcast or multi-audio-track.
    const sdp = [
      "v=0",
      "m=audio 9 UDP/TLS/RTP/SAVPF 111",
      "m=audio 9 UDP/TLS/RTP/SAVPF 111",
      "m=video 9 UDP/TLS/RTP/SAVPF 96",
      "",
    ].join("\r\n");
    const summary = summarizeSdp({ type: "offer", sdp });
    expect(summary.mSectionCounts).toEqual({ audio: 2, video: 1, data: 0 });
    expect(summary.mSections).toEqual({
      audio: true,
      video: true,
      data: false,
    });
  });

  it("returns zeros for an SDP with no recognized m-sections", () => {
    const summary = summarizeSdp({ type: "offer", sdp: "v=0\r\no=- 1 1\r\n" });
    expect(summary.mSections).toEqual({
      audio: false,
      video: false,
      data: false,
    });
    expect(summary.mSectionCounts).toEqual({ audio: 0, video: 0, data: 0 });
  });

  it("handles `answer` kind without regressing counts", () => {
    const sdp =
      "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n";
    const summary = summarizeSdp({ type: "answer", sdp });
    expect(summary.kind).toBe("answer");
    expect(summary.mSections.audio).toBe(true);
    expect(summary.mSections.data).toBe(false);
  });

  it("tolerates missing sdp body (defaults to empty)", () => {
    // Some test fakes return `{ type: 'offer' }` with no sdp. The
    // summarizer must not throw.
    const summary = summarizeSdp({ type: "offer" } as RTCSessionDescriptionInit);
    expect(summary.sdpBytes).toBe(0);
    expect(summary.mSections).toEqual({
      audio: false,
      video: false,
      data: false,
    });
  });

  it("does not match m-sections inside comment lines", () => {
    // Lines that start with `a=m=` (attribute starting with literal
    // "m=") are NOT m-sections; only lines where the first two chars
    // are `m=` count.
    const sdp = "v=0\r\na=m=audio fake\r\nm=audio 9 UDP\r\n";
    const summary = summarizeSdp({ type: "offer", sdp });
    expect(summary.mSectionCounts.audio).toBe(1);
  });
});

describe("summarizeCandidate", () => {
  it("classifies host/UDP correctly", () => {
    const s = summarizeCandidate({
      candidate: "candidate:1 1 UDP 2130706431 192.0.2.10 54321 typ host",
    });
    expect(s).toEqual({ type: "host", protocol: "udp" });
  });

  it("classifies srflx/UDP correctly", () => {
    const s = summarizeCandidate({
      candidate:
        "candidate:2 1 UDP 1686052607 198.51.100.7 55555 typ srflx raddr 192.0.2.10 rport 54321",
    });
    expect(s.type).toBe("srflx");
    expect(s.protocol).toBe("udp");
  });

  it("classifies prflx/UDP correctly", () => {
    const s = summarizeCandidate({
      candidate: "candidate:3 1 UDP 1 10.0.0.5 40000 typ prflx",
    });
    expect(s.type).toBe("prflx");
  });

  it("classifies relay/UDP correctly", () => {
    const s = summarizeCandidate({
      candidate: "candidate:4 1 UDP 1 198.51.100.100 33333 typ relay",
    });
    expect(s.type).toBe("relay");
  });

  it("classifies TCP protocol independently of type", () => {
    const s = summarizeCandidate({
      candidate: "candidate:5 1 TCP 1 192.0.2.10 9 typ host tcptype passive",
    });
    expect(s).toEqual({ type: "host", protocol: "tcp" });
  });

  it("returns unknown when protocol is absent", () => {
    const s = summarizeCandidate({ candidate: "not-even-a-candidate-line" });
    expect(s).toEqual({ type: "unknown", protocol: "unknown" });
  });

  it("is case-insensitive on type/protocol tokens", () => {
    const s = summarizeCandidate({
      candidate: "candidate:1 1 udp 100 1.2.3.4 5678 TYP HOST",
    });
    expect(s).toEqual({ type: "host", protocol: "udp" });
  });
});

describe("summarizeIceServers", () => {
  it("flags STUN + TURN when mixed in the configured list", () => {
    const s = summarizeIceServers([
      { urls: "stun:stun.l.google.com:19302" },
      { urls: ["turn:turn.example.com:3478", "turns:turn.example.com:5349"] },
    ]);
    expect(s).toEqual({ stunConfigured: true, turnConfigured: true });
  });

  it("flags only STUN when TURN is absent", () => {
    const s = summarizeIceServers([
      { urls: ["stun:stun1.example.com", "stun:stun2.example.com"] },
    ]);
    expect(s).toEqual({ stunConfigured: true, turnConfigured: false });
  });

  it("returns both false for an empty list", () => {
    expect(summarizeIceServers([])).toEqual({
      stunConfigured: false,
      turnConfigured: false,
    });
  });

  it("is case-insensitive on URL scheme", () => {
    const s = summarizeIceServers([
      { urls: ["STUN:stun.example.com", "TURNS:turn.example.com"] },
    ]);
    expect(s).toEqual({ stunConfigured: true, turnConfigured: true });
  });
});
