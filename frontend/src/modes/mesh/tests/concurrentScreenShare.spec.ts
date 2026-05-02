// T079 / T078 — concurrent screen-share invariants (M10).
//
// Asserts the "no room-level sharer" property at structural + state
// levels:
//   - No `currentSharer` global / store / hook / reducer field exists
//     anywhere under frontend/src/modes/mesh/ or signaling/internal/mesh/.
//   - No `screen_share_busy` message type or error code exists in the
//     mesh client / server contract surfaces.
//   - Two simulated remote participants may both have `screenShare`
//     active in the roster slice — neither preempts the other.
//   - One sharer stopping does not mutate the other sharer's state.
//   - The RemoteTile source indicator remains per-peer (asserted via
//     the roster slice's per-peer `remoteMedia.screenShare`).
//
// Verify with:
//   npx vitest run src/modes/mesh/tests/concurrentScreenShare.spec.ts

import { describe, expect, it } from "vitest";
import {
  initialMeshRosterSlice,
  meshRosterReducer,
  defaultRemoteMediaState,
} from "../state/roster";

const PEER_B = "22222222-2222-4222-8222-222222222222";
const PEER_C = "33333333-3333-4333-8333-333333333333";

describe("no room-level current-sharer concept (T078)", () => {
  it("two distinct remote peers can independently transition to screenShare='active'", () => {
    let s = meshRosterReducer(initialMeshRosterSlice, {
      type: "MESH_ROSTER_SNAPSHOT_APPLIED",
      serverSeq: 1,
      participants: [
        { peerId: PEER_B, admissionIndex: 2, presence: "media-ready" },
        { peerId: PEER_C, admissionIndex: 3, presence: "media-ready" },
      ],
    });
    s = meshRosterReducer(s, {
      type: "MESH_REMOTE_MEDIA_STATE_APPLIED",
      subjectPeerId: PEER_B,
      microphone: "on",
      camera: "on",
      screenShare: "active",
    });
    s = meshRosterReducer(s, {
      type: "MESH_REMOTE_MEDIA_STATE_APPLIED",
      subjectPeerId: PEER_C,
      microphone: "on",
      camera: "on",
      screenShare: "active",
    });
    expect(s.byPeerId[PEER_B]?.remoteMedia.screenShare).toBe("active");
    expect(s.byPeerId[PEER_C]?.remoteMedia.screenShare).toBe("active");
  });

  it("one remote peer stopping screen share does not mutate the other peer's screenShare", () => {
    let s = meshRosterReducer(initialMeshRosterSlice, {
      type: "MESH_ROSTER_SNAPSHOT_APPLIED",
      serverSeq: 1,
      participants: [
        { peerId: PEER_B, admissionIndex: 2, presence: "media-ready" },
        { peerId: PEER_C, admissionIndex: 3, presence: "media-ready" },
      ],
    });
    s = meshRosterReducer(s, {
      type: "MESH_REMOTE_MEDIA_STATE_APPLIED",
      subjectPeerId: PEER_B,
      microphone: "on",
      camera: "on",
      screenShare: "active",
    });
    s = meshRosterReducer(s, {
      type: "MESH_REMOTE_MEDIA_STATE_APPLIED",
      subjectPeerId: PEER_C,
      microphone: "on",
      camera: "on",
      screenShare: "active",
    });
    s = meshRosterReducer(s, {
      type: "MESH_REMOTE_MEDIA_STATE_APPLIED",
      subjectPeerId: PEER_B,
      microphone: "on",
      camera: "on",
      screenShare: "inactive",
    });
    expect(s.byPeerId[PEER_B]?.remoteMedia.screenShare).toBe("inactive");
    // C's state is untouched — there is no room-level mutex that would
    // have stopped C when B started, nor when B stopped.
    expect(s.byPeerId[PEER_C]?.remoteMedia.screenShare).toBe("active");
  });

  it("default remoteMedia keeps screenShare='inactive' until a per-peer pair_media_state arrives", () => {
    expect(defaultRemoteMediaState.screenShare).toBe("inactive");
  });
});

describe("structural absence of forbidden symbols (T078)", () => {
  it("`currentSharer` is not present anywhere under frontend/src/modes/mesh/", async () => {
    const matches = await grepUnder(
      "frontend/src/modes/mesh",
      /currentSharer/,
    );
    expect(matches).toEqual([]);
  });

  it("`currentSharer` is not present anywhere under signaling/internal/modes/mesh/", async () => {
    const matches = await grepUnder(
      "signaling/internal/modes/mesh",
      /currentSharer/,
    );
    expect(matches).toEqual([]);
  });

  it("`screen_share_busy` is not present in non-test mesh frontend files", async () => {
    // Audit specs / negative-assertion tests reference the string by
    // design; we restrict the search to non-test mesh source files.
    const matches = await grepUnder(
      "frontend/src/modes/mesh",
      /screen_share_busy/,
      (p) => p.endsWith(".spec.ts") || p.endsWith(".spec.tsx"),
    );
    // The schema file declares the string in a comment-only audit
    // line ("`screen_share_busy` is absent ..."). Filter out comment
    // matches by re-reading and checking that no non-comment line
    // contains the literal.
    expect(matches).toEqual([]);
  });

  it("`screen_share_busy` is not a server message or error code (signaling)", async () => {
    const matches = await grepUnder(
      "signaling/internal/modes/mesh",
      /screen_share_busy/,
      (p) => p.endsWith("_test.go"),
    );
    // Same audit-comment rule as above.
    expect(matches).toEqual([]);
  });

  it("frontend/src/modes/mesh/webrtc/screenShare.ts contains no addTransceiver invocation", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const here = path.resolve(__dirname, "../webrtc/screenShare.ts");
    const src = await fs.readFile(here, "utf8");
    const code = src
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(code).not.toMatch(/addTransceiver\s*\(/);
  });
});

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

async function grepUnder(
  relRoot: string,
  re: RegExp,
  excludeIf?: (relPath: string) => boolean,
): Promise<string[]> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const repoRoot = path.resolve(__dirname, "../../../../../..");
  const root = path.resolve(repoRoot, relRoot);
  const matches: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.resolve(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = path.relative(repoRoot, full);
      if (excludeIf?.(rel)) continue;
      // Only consider source files (skip build artifacts / lockfiles).
      if (!/\.(ts|tsx|js|jsx|go|md)$/.test(rel)) continue;
      let body: string;
      try {
        body = await fs.readFile(full, "utf8");
      } catch {
        continue;
      }
      // Strip line-comments — JS/TS // comments and Go // comments.
      const stripped = body
        .split("\n")
        .filter((line) => !line.trim().startsWith("//"))
        .join("\n");
      if (re.test(stripped)) matches.push(rel);
    }
  }
  await walk(root);
  return matches;
}
