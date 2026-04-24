// Phase 6, Scenario 6 — US1 AS1 / EC-001.
//
// A single peer joins an empty room, acquires media, and reaches the
// waiting-for-peer state with the local video preview visible. No
// remote peer is required — the scenario asserts only the joiner's
// own state.

import { expect, test } from "@playwright/test";
import {
  expectEventOfType,
  expectIndicator,
  joinRoom,
  roomIdFor,
  testAppUrl,
} from "./fixtures";

test("solo peer joining an empty room reaches waiting-for-peer", async ({
  browser,
}, testInfo) => {
  const roomId = roomIdFor(testInfo);

  const ctx = await browser.newContext();
  try {
    const page = await ctx.newPage();
    await page.goto(testAppUrl());

    await joinRoom(page, roomId);

    await expectEventOfType(page, "room_joined", /room joined/);
    await expectEventOfType(
      page,
      "media_ready_sent",
      /media_ready sent \(audio\+video ready\)/,
    );
    // Strict equality against `waiting-for-peer` — stronger than
    // `expectSessionAdvanced` which would also pass for
    // `connecting`/`connected`. Forward-compatible because a solo
    // peer can never advance past `waiting-for-peer` under any
    // phase: role assignment and PC creation require both peers
    // media-ready (contract §3.7).
    await expectIndicator(page, "session", "waiting-for-peer");

    await expect(page.locator(".local-video__video")).toBeVisible();
    await expect(page.locator(".local-video__placeholder")).toHaveCount(0);
  } finally {
    await ctx.close();
  }
});
