// Learning Inspector v1 — Phase 8 (T062, FR-030).
//
// Pure summarizers that turn SDP and ICE candidate bodies into
// human-readable counters + booleans. **No raw SDP line or candidate
// string ever escapes this module.** Per NFR-006 / Principle VIII the
// panel component must render only the outputs of this file.
//
// Scope:
// - SDP m-section enumeration (`audio`/`video`/`application`).
// - ICE candidate-type classification into the four canonical types
//   (`host`/`srflx`/`prflx`/`relay`), plus transport-protocol kind.
// - STUN/TURN configured-vs-observed — computed by the provider from
//   the server-supplied `iceServers` list + the observed candidate
//   types.
//
// The module is deliberately minimal: it answers the didactic
// questions in the Purpose / learning-outcome list without pretending
// to be a full WebRTC analyzer. Phase 8 exit criterion is "at least
// one `host` candidate observed"; everything richer stays in future
// phases.

export interface SdpSummary {
  kind: "offer" | "answer";
  /** Total byte length of the SDP body (for a cheap sanity check). */
  sdpBytes: number;
  /** Presence of each canonical m-section. */
  mSections: {
    audio: boolean;
    video: boolean;
    data: boolean;
  };
  /** Count of m-sections by kind for the rare 2-audio / 2-video case. */
  mSectionCounts: {
    audio: number;
    video: number;
    data: number;
  };
}

export function summarizeSdp(
  body: { type: "offer" | "answer"; sdp: string } | RTCSessionDescriptionInit,
): SdpSummary {
  const sdp = body.sdp ?? "";
  // Per-line prefix check is enough — SDP m-lines always start with
  // `m=<kind> <port> <proto> ...` at the start of a line. We count by
  // kind so the Learning Inspector can display the exact m-section
  // structure without ever rendering the raw body.
  const audio = countLines(sdp, /^m=audio /gm);
  const video = countLines(sdp, /^m=video /gm);
  const data = countLines(sdp, /^m=application /gm);
  return {
    kind: (body.type as "offer" | "answer") ?? "offer",
    sdpBytes: sdp.length,
    mSections: {
      audio: audio > 0,
      video: video > 0,
      data: data > 0,
    },
    mSectionCounts: { audio, video, data },
  };
}

function countLines(sdp: string, re: RegExp): number {
  let n = 0;
  // `matchAll` would allocate an iterator; a cheap while/exec is fine
  // here and avoids matching across the very long SDP bodies some
  // browsers emit (Firefox) more than once per call.
  while (re.exec(sdp) !== null) n += 1;
  // Reset lastIndex so the caller can reuse the regex (ours are module-
  // local literals so this is paranoia, but costs nothing).
  re.lastIndex = 0;
  return n;
}

// ---------------------------------------------------------------------
// ICE candidate classification
// ---------------------------------------------------------------------

export type CandidateType = "host" | "srflx" | "prflx" | "relay" | "unknown";
export type CandidateProtocol = "udp" | "tcp" | "unknown";

export interface CandidateSummary {
  type: CandidateType;
  protocol: CandidateProtocol;
}

/**
 * Parse the `type <x>` and protocol fields out of a candidate-
 * attribute string. The string is opaque to the signaling contract
 * but locally harmless — we read only the two tokens we need, and the
 * caller discards the raw body immediately after.
 *
 * Format reminder (RFC 8839 §5.1):
 *   candidate:FOUNDATION COMPONENT PROTO PRIORITY IP PORT typ TYPE ...
 */
export function summarizeCandidate(
  candidate: RTCIceCandidateInit,
): CandidateSummary {
  const raw = candidate.candidate ?? "";
  return {
    type: parseCandidateType(raw),
    protocol: parseCandidateProtocol(raw),
  };
}

function parseCandidateType(raw: string): CandidateType {
  // `typ <token>` appears once per candidate line, after the fixed
  // positional fields. We match non-greedily to the next whitespace.
  const m = /\btyp\s+(host|srflx|prflx|relay)\b/i.exec(raw);
  if (!m) return "unknown";
  return m[1]?.toLowerCase() as CandidateType;
}

function parseCandidateProtocol(raw: string): CandidateProtocol {
  // Protocol is the 3rd whitespace-separated token of the candidate
  // line (after "candidate:FOUND COMP"). Matching on a dedicated
  // regex avoids split/array bookkeeping and keeps the token set
  // narrow.
  const m = /^candidate:\S+\s+\S+\s+(UDP|TCP)\b/i.exec(raw);
  if (!m) return "unknown";
  return m[1]?.toLowerCase() as CandidateProtocol;
}

// ---------------------------------------------------------------------
// Aggregate — what the LearningInspector panel actually reads
// ---------------------------------------------------------------------

/**
 * Derivable from the server-supplied `iceServers`. `stunConfigured`
 * is true when any entry carries a `stun:` URL; `turnConfigured` is
 * true when any entry carries a `turn:` or `turns:` URL. Credentials
 * are never stored or rendered — we only report yes/no.
 */
export interface IceServerSummary {
  stunConfigured: boolean;
  turnConfigured: boolean;
}

export function summarizeIceServers(
  iceServers: ReadonlyArray<{ urls: string | string[] }>,
): IceServerSummary {
  let stun = false;
  let turn = false;
  for (const server of iceServers) {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    for (const url of urls) {
      if (/^stun:/i.test(url)) stun = true;
      if (/^turns?:/i.test(url)) turn = true;
    }
  }
  return { stunConfigured: stun, turnConfigured: turn };
}

/**
 * The LearningInspector renders this snapshot verbatim.
 * - `configured` reports what the server supplied.
 * - `observed` reports what `onicecandidate` actually emitted —
 *   `srflxObserved === true` means the local browser reached a STUN
 *   server; `relayObserved === true` means it rolled to TURN.
 */
export interface LearningInspectorSnapshot {
  local: SdpSummary | null;
  remote: SdpSummary | null;
  configured: IceServerSummary;
  observed: {
    hostCandidates: number;
    srflxCandidates: number;
    prflxCandidates: number;
    relayCandidates: number;
    endOfLocalCandidates: boolean;
    endOfRemoteCandidates: boolean;
  };
}

export const initialInspectorSnapshot: LearningInspectorSnapshot = {
  local: null,
  remote: null,
  configured: { stunConfigured: false, turnConfigured: false },
  observed: {
    hostCandidates: 0,
    srflxCandidates: 0,
    prflxCandidates: 0,
    relayCandidates: 0,
    endOfLocalCandidates: false,
    endOfRemoteCandidates: false,
  },
};
