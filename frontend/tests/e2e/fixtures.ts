// Shared helpers for the Phase 6 Playwright scenarios.
//
// Assertion style is **presence-based** and keyed to the DOM surface
// actually shipped today (EventLogPanel.tsx, StateIndicators.tsx,
// JoinForm.tsx). Never assert exact event-log row counts or strict
// ordering — StrictMode-off + retries + server broadcast ordering
// make those fragile, and the plan forbids them.

import { randomBytes } from "node:crypto";
import { expect, type Page, type TestInfo } from "@playwright/test";

export type MediaMode = "real" | "failOnce";

export type SessionStateName =
  | "idle"
  | "joining"
  | "pending-media"
  | "waiting-for-peer"
  | "media-error"
  | "connecting"
  | "connected"
  | "failed"
  | "leaving";

// States that indicate the session has NOT advanced past Phase 6's
// pre-readiness set. Anything outside this set means local-media
// acquisition has succeeded and pairing is under way (or complete).
// Kept here so Phase 7+ extensions (`connecting`, `connected`) do not
// require touching every scenario.
const PRE_READY_STATES: readonly SessionStateName[] = [
  "idle",
  "joining",
  "pending-media",
  "media-error",
  "failed",
  "leaving",
];

export function roomIdFor(testInfo: TestInfo): string {
  // 12 hex chars → always matches `^[A-Za-z0-9._-]{1,64}$` and stays
  // well under the 64-char ceiling. `randomBytes` over a hash of
  // `testInfo.testId` because collision across retries is harmless
  // and uniqueness avoids any "stuck slot from the last attempt"
  // race. `workerIndex` is retained in the prefix so the helper
  // survives a future `workers > 1` flip.
  const suffix = randomBytes(6).toString("hex");
  return `r-${testInfo.workerIndex}-${suffix}`;
}

export function testAppUrl(opts: { media?: MediaMode } = {}): string {
  const base = "/tests/e2e/test-app/index.html";
  return opts.media ? `${base}?media=${opts.media}` : base;
}

// --- Event-log helpers ----------------------------------------------

// Assert (and wait, up to the project expect timeout) that the event
// log contains AT LEAST ONE row whose `.event-log__type` matches
// `type` AND whose `.event-log__summary` matches `summaryMatcher`.
// Never asserts count or position.
export async function expectEventOfType(
  page: Page,
  type: string,
  summaryMatcher: string | RegExp,
): Promise<void> {
  const row = page
    .locator("li.event-log__row")
    .filter({
      has: page.locator(".event-log__type", {
        hasText: new RegExp(`^${escapeRegExp(type)}$`),
      }),
    })
    .filter({
      has: page.locator(".event-log__summary", { hasText: summaryMatcher }),
    });
  await expect(row.first()).toBeVisible();
}

// --- State-indicator helpers ---------------------------------------

function indicatorDd(page: Page, label: string) {
  return page
    .locator(".state-indicators__item")
    .filter({
      has: page.locator("dt", {
        hasText: new RegExp(`^${escapeRegExp(label)}$`),
      }),
    })
    .locator("dd");
}

export async function expectIndicator(
  page: Page,
  label: string,
  matcher: string | RegExp,
): Promise<void> {
  await expect(indicatorDd(page, label)).toHaveText(matcher);
}

export async function expectIndicatorNotMatching(
  page: Page,
  label: string,
  matcher: RegExp,
): Promise<void> {
  await expect(indicatorDd(page, label)).not.toHaveText(matcher);
}

// Convenience: assert the `session` indicator has advanced past the
// pre-readiness set (phase-6 success ⇒ `waiting-for-peer`; phase 7+ ⇒
// `connecting` / `connected`). Stable across phase extensions.
export async function expectSessionAdvanced(page: Page): Promise<void> {
  await expectIndicatorNotMatching(
    page,
    "session",
    new RegExp(`^(${PRE_READY_STATES.join("|")})$`),
  );
}

// --- US5 AS1 base-lifecycle helper ---------------------------------

// Asserts every Phase-6-reachable base lifecycle event appears in
// this page's event log. Call from the happy path (two peers both
// reaching media-ready) — a peer that never admits a remote will
// not see the two `peer_presence_changed` rows.
//
// Phase-7+ extends this helper in place: add `offer_created/received`,
// `answer_created/received`, `ice_candidate_*`, `*state_changed`,
// `cleanup_completed`. Scenarios that call the helper automatically
// pick up the new coverage without edit.
export async function expectBaseLifecycleEvents(page: Page): Promise<void> {
  await expectEventOfType(page, "transport_changed", /connected/);
  await expectEventOfType(page, "join_room_sent", /join_room sent/);
  await expectEventOfType(page, "room_joined", /room joined/);
  await expectEventOfType(page, "media_acquire_started", /getUserMedia/);
  await expectEventOfType(
    page,
    "media_ready_sent",
    /media_ready sent \(audio\+video ready\)/,
  );
  await expectEventOfType(page, "peer_presence_changed", /pending-media/);
  await expectEventOfType(page, "peer_presence_changed", /ready/);
}

// --- JoinForm helpers ----------------------------------------------

export async function joinRoom(page: Page, roomId: string): Promise<void> {
  await page.fill("#room-id-input", roomId);
  await page.getByRole("button", { name: /^Join(?:ing…)?$/ }).click();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
