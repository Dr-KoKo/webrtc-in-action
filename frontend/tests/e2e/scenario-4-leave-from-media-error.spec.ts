// Phase 6, Scenario 4 — Leave from `media-error` returns the session
// to `idle`, hides the Retry/Leave affordances, and clears roomId.
// Only `?media=failOnce` is needed (no second peer): a media failure
// on the single admitted peer drives `pending-media → media-error` via
// `participant_released(media_failed)` on the same WebSocket.

import { expect, test } from "@playwright/test";
import {
  expectEventOfType,
  expectIndicator,
  joinRoom,
  roomIdFor,
  testAppUrl,
} from "./fixtures";

test("Leave from media-error returns the session to idle", async ({
  browser,
}, testInfo) => {
  const roomId = roomIdFor(testInfo);

  const ctx = await browser.newContext();
  try {
    const page = await ctx.newPage();
    await page.goto(testAppUrl({ media: "failOnce" }));

    await joinRoom(page, roomId);
    // Gate on admission before waiting on the terminal state — gives
    // a sharper failure message if signaling is slow, and matches the
    // pattern used in Scenarios 1/2/3/5/7.
    await expectEventOfType(page, "room_joined", /room joined/);
    await expectIndicator(page, "session", "media-error");

    await page.getByRole("button", { name: /^Leave$/ }).click();

    await expectIndicator(page, "session", "idle");
    await expectIndicator(page, "room id", "—");
    await expect(page.getByRole("button", { name: /^Retry$/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Leave$/ })).toHaveCount(0);
    await expectEventOfType(page, "leave_requested", /user clicked Leave/);
  } finally {
    await ctx.close();
  }
});
