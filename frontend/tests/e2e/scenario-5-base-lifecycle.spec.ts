// Phase 6, Scenario 5 — US5 AS1 (Phase-6 subset).
//
// Two peers complete the happy path; each peer's event log carries
// every Phase-6-reachable base lifecycle event. The helper
// `expectBaseLifecycleEvents` is the single source of truth for the
// event list — extend it in `fixtures.ts` when Phase 7+ adds
// `offer_*`, `answer_*`, `ice_candidate_*`, `*state_changed`, and
// `cleanup_completed`.

import { test } from "@playwright/test";
import {
  expectBaseLifecycleEvents,
  expectEventOfType,
  joinRoom,
  roomIdFor,
  testAppUrl,
} from "./fixtures";

test("base lifecycle events are observable on both peers", async ({
  browser,
}, testInfo) => {
  const roomId = roomIdFor(testInfo);

  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  try {
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    await pageA.goto(testAppUrl());
    await pageB.goto(testAppUrl());

    await joinRoom(pageA, roomId);
    await expectEventOfType(pageA, "room_joined", /room joined/);

    await joinRoom(pageB, roomId);

    // Both peers should have sent media_ready before we check the
    // full lifecycle — the helper's `peer_presence_changed → ready`
    // row only appears once the remote advances.
    for (const page of [pageA, pageB]) {
      await expectEventOfType(
        page,
        "media_ready_sent",
        /media_ready sent \(audio\+video ready\)/,
      );
    }

    for (const page of [pageA, pageB]) {
      await expectBaseLifecycleEvents(page);
    }
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});
