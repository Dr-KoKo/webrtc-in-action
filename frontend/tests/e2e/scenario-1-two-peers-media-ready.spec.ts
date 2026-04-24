// Phase 6, Scenario 1 — Two peers join the same room, both acquire
// media successfully, and both emit `media_ready`.
//
// Forward-compatible: we assert the session indicator has ADVANCED
// past pre-readiness (not strictly "waiting-for-peer"), so Phase 7+
// transitions (`connecting`, `connected`) don't break this scenario.

import { expect, test } from "@playwright/test";
import {
  expectEventOfType,
  expectSessionAdvanced,
  joinRoom,
  roomIdFor,
  testAppUrl,
} from "./fixtures";

test("two peers join the same room and each emits media_ready", async ({
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

    for (const page of [pageA, pageB]) {
      await expectEventOfType(
        page,
        "media_ready_sent",
        /media_ready sent \(audio\+video ready\)/,
      );
      await expectSessionAdvanced(page);
    }

    // Each peer sees the OTHER peer's readiness over the
    // peer_presence_changed stream. Summary contains "ready"
    // (possibly "pending-media → ready" after Phase 7 adds
    // `in-call`, still matches this substring).
    for (const page of [pageA, pageB]) {
      await expectEventOfType(page, "peer_presence_changed", /ready/);
    }

    for (const page of [pageA, pageB]) {
      await expect(page.locator(".local-video__video")).toBeVisible();
      await expect(page.locator(".local-video__placeholder")).toHaveCount(0);
    }
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});
