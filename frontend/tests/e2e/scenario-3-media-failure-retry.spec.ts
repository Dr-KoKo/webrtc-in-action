// Phase 6, Scenario 3 — Peer B's getUserMedia fails once, the server
// releases B's slot, B lands in `media-error`, user clicks Retry, and
// the second acquire succeeds.
//
// The `?media=failOnce` query param on peer B's test-entry URL
// installs a closure `getUserMedia` that throws `NotAllowedError` on
// the first call and delegates to the real fake-device pipeline
// afterward. StrictMode is off in the test entry so the counter
// reliably sees exactly one call per acquire attempt.

import { expect, test } from "@playwright/test";
import {
  expectEventOfType,
  expectIndicator,
  expectSessionAdvanced,
  joinRoom,
  roomIdFor,
  testAppUrl,
} from "./fixtures";

test("media failure drives media-error; Retry recovers to media-ready", async ({
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

    await joinRoom(pageB, roomId);

    await expectEventOfType(
      pageB,
      "media_failed_sent",
      /media_failed sent \(permission_denied\)/,
    );
    await expectEventOfType(
      pageB,
      "participant_released",
      /slot released \(media_failed\)/,
    );
    await expectIndicator(pageB, "session", "media-error");
    await expect(pageB.getByRole("button", { name: /^Retry$/ })).toBeVisible();
    await expect(pageB.getByRole("button", { name: /^Leave$/ })).toBeVisible();
    await expect(
      pageB
        .getByRole("alert")
        .filter({ hasText: /Camera or microphone unavailable/ }),
    ).toBeVisible();

    await pageB.getByRole("button", { name: /^Retry$/ }).click();

    await expectEventOfType(pageB, "retry_requested", /retry media acquisition/);
    await expectEventOfType(
      pageB,
      "media_ready_sent",
      /media_ready sent \(audio\+video ready\)/,
    );
    await expectSessionAdvanced(pageB);
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});
