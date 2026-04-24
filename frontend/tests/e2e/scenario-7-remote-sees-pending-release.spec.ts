// Phase 6, Scenario 7 — US1 AS6 (the remaining peer's side).
//
// Scenario 3 covers B's side of the media-failure + retry loop; this
// scenario covers A's side: A is already media-ready and waiting for
// B, B's media acquisition fails, the server releases B's slot, and
// A observes the release in the event log without regressing session
// state.

import { test } from "@playwright/test";
import {
  expectEventOfType,
  expectIndicator,
  expectSessionAdvanced,
  joinRoom,
  roomIdFor,
  testAppUrl,
} from "./fixtures";

test("waiting peer observes a pending-media release", async ({
  browser,
}, testInfo) => {
  const roomId = roomIdFor(testInfo);

  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  try {
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    await pageA.goto(testAppUrl());
    await pageB.goto(testAppUrl({ media: "failOnce" }));

    await joinRoom(pageA, roomId);
    await expectEventOfType(pageA, "room_joined", /room joined/);
    await expectEventOfType(
      pageA,
      "media_ready_sent",
      /media_ready sent \(audio\+video ready\)/,
    );

    await joinRoom(pageB, roomId);

    // A sees B admitted (pending-media) then released with
    // reason=media_failed. Both rows share the `peer_presence_changed`
    // type; the summary disambiguates.
    await expectEventOfType(pageA, "peer_presence_changed", /pending-media/);
    await expectEventOfType(
      pageA,
      "peer_presence_changed",
      /released \(media_failed\)/,
    );

    // A's session state is not rolled back by the remote release;
    // A remains in the post-pending-media set.
    await expectSessionAdvanced(pageA);

    // Remote indicator returns to "none" after the release.
    await expectIndicator(pageA, "remote peer presence", "none");
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});
