// Phase 6, Scenario 2 — Third peer joining a full room is rejected
// with `join_rejected_room_full`. Contract §3.1 rule 2: the room is
// full as soon as two slots are reserved, regardless of media state,
// so we do not need to wait for peer A/B to complete media
// acquisition before peer C joins.

import { expect, test } from "@playwright/test";
import {
  expectEventOfType,
  expectIndicator,
  joinRoom,
  roomIdFor,
  testAppUrl,
} from "./fixtures";

test("third peer is rejected with join_rejected_room_full", async ({
  browser,
}, testInfo) => {
  const roomId = roomIdFor(testInfo);

  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const ctxC = await browser.newContext();
  try {
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    const pageC = await ctxC.newPage();

    await pageA.goto(testAppUrl());
    await pageB.goto(testAppUrl());
    await pageC.goto(testAppUrl());

    await joinRoom(pageA, roomId);
    await expectEventOfType(pageA, "room_joined", /room joined/);

    await joinRoom(pageB, roomId);
    await expectEventOfType(pageB, "room_joined", /room joined/);

    await joinRoom(pageC, roomId);

    await expectEventOfType(pageC, "error_occurred", /^join rejected:/);
    await expect(
      pageC
        .getByRole("alert")
        .filter({ hasText: /Room/ })
        .filter({ hasText: /reserved/ }),
    ).toBeVisible();
    await expectIndicator(pageC, "session", "idle");
    await expectIndicator(pageC, "room id", "—");
  } finally {
    await ctxA.close();
    await ctxB.close();
    await ctxC.close();
  }
});
