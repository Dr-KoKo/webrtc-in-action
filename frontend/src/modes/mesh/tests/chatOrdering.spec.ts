// T065 — per-channel ordering only (FR-055).
//
// Asserts:
//   - Inbound messages from different senders remain in arrival order
//     even when their `sentAt` clocks would suggest a different order.
//   - No global ordering machinery (Lamport clocks, vector clocks,
//     server-assigned sequence numbers) is implemented in the mesh
//     state surface — verified by static source scan.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  initialMeshChatSlice,
  meshChatReducer,
} from "../state/chat";

const ALPHA = "11111111-1111-4111-8111-111111111111";
const BETA = "22222222-2222-4222-8222-222222222222";

describe("per-channel ordering", () => {
  it("messages from different senders stay in local arrival order", () => {
    let s = initialMeshChatSlice;
    s = meshChatReducer(s, {
      type: "MESH_CHAT_INBOUND_APPENDED",
      message: {
        id: "from-alpha",
        authorPeerId: ALPHA,
        text: "alpha first to arrive, second to send",
        sentAt: 5000,
        receivedAt: 10000,
      },
    });
    s = meshChatReducer(s, {
      type: "MESH_CHAT_INBOUND_APPENDED",
      message: {
        id: "from-beta",
        authorPeerId: BETA,
        text: "beta second to arrive, first to send",
        sentAt: 1000,
        receivedAt: 10100,
      },
    });
    expect(s.messages.map((m) => m.id)).toEqual(["from-alpha", "from-beta"]);
  });
});

describe("no global ordering protocol exists in mesh state", () => {
  // Walk every TS/TSX file under modes/mesh/{state,webrtc,components}
  // and assert no Lamport / vector-clock keywords appear (FR-055).
  const ROOTS = [
    join(__dirname, "..", "state"),
    join(__dirname, "..", "webrtc"),
    join(__dirname, "..", "components"),
  ];
  const FORBIDDEN = [
    /\bLamport\b/i,
    /\bvector[_\s-]?clock\b/i,
    /\bglobal[_\s-]?ordering\b/i,
    /\btotal[_\s-]?order\b/i,
  ];

  function walk(dir: string): string[] {
    const entries = readdirSync(dir, { withFileTypes: true });
    const out: string[] = [];
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) out.push(...walk(p));
      else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
    }
    return out;
  }

  it("source files do not implement Lamport / vector-clock ordering", () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(root)) {
        const body = readFileSync(file, "utf8");
        for (const pat of FORBIDDEN) {
          if (pat.test(body)) {
            offenders.push(`${file} matches ${pat}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
