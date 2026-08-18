import type { Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "../../support/fixtures";
import { ALICE, BOB } from "../../support/users";

/**
 * `minor`/`moderate` findings on this app skew toward noise (contrast on
 * decorative elements, landmark nitpicks) rather than something a real user
 * would trip over — filtering to `serious`/`critical` is what keeps this
 * spec a signal worth failing a build over.
 */
const SIGNIFICANT_IMPACTS = new Set(["serious", "critical"]);

// Derived from AxeBuilder's own return type rather than imported from
// `axe-core` directly — this package only declares `@axe-core/playwright`
// as a dependency (see package.json), and `axe-core` itself isn't hoisted
// anywhere this workspace's strict pnpm linking would let TypeScript see it.
type Violations = Awaited<ReturnType<AxeBuilder["analyze"]>>["violations"];

/** One bullet per violation — id, impact, help text, node count — for the failure message. */
function summarize(violations: Violations): string {
  return violations
    .map(
      (violation) =>
        `- [${violation.impact ?? "unknown"}] ${violation.id}: ${violation.help} ` +
        `(${String(violation.nodes.length)} node(s)) — ${violation.helpUrl}`,
    )
    .join("\n");
}

/** Runs axe over the page and asserts no serious or critical violations remain. */
async function expectNoSeriousViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  const significant = results.violations.filter((violation) =>
    SIGNIFICANT_IMPACTS.has(violation.impact ?? ""),
  );

  expect(
    significant,
    `Serious/critical accessibility violations:\n${summarize(significant)}`,
  ).toEqual([]);
}

test.describe("accessibility", () => {
  test("/ (the home feed) has no serious or critical violations", async ({ page }) => {
    await page.goto("/");
    await expectNoSeriousViolations(page);
  });

  test("/login has no serious or critical violations", async ({ signedOutPage }) => {
    await signedOutPage.goto("/login");
    await expectNoSeriousViolations(signedOutPage);
  });

  test("the 404 page has no serious or critical violations", async ({ page }) => {
    await page.goto("/this-page-does-not-exist");
    await expectNoSeriousViolations(page);
  });

  test("a profile page has no serious or critical violations", async ({ page }) => {
    await page.goto(`/@${ALICE.username}`);
    await expectNoSeriousViolations(page);
  });

  // The desk is the app's densest screen — tabs, a table, badges and a
  // modal full of form controls — and alice is the moderator fixture, so it
  // is reachable here without seeding a second role.
  test("the moderation desk has no serious or critical violations", async ({ page, db }) => {
    const bobId = await db.getUserId(BOB.username);
    const [reported] = await db.seedPosts(bobId, 1, {
      content: () => `Accessibility scan target ${Date.now().toString()}`,
    });
    if (!reported) throw new Error("seedPosts returned no row");
    const report = {
      reporterId: await db.getUserId(ALICE.username),
      targetType: "post" as const,
      targetId: reported.id,
    };
    await db.seedReport({ ...report, reason: "spam" });

    try {
      await page.goto("/moderation");
      await expect(page.getByRole("heading", { name: "Moderation" })).toBeVisible();
      await expectNoSeriousViolations(page);

      // Again with the case dialog open: its form controls are the half of the
      // desk a scan of the list alone never reaches.
      await page
        .getByRole("button", { name: /1 report/ })
        .first()
        .click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await expectNoSeriousViolations(page);
    } finally {
      // Even on a failed scan: an open report left behind is a case in every
      // later spec's queue (see `deleteReport`).
      await db.deleteReport(report);
    }
  });

  test("a thread page has no serious or critical violations", async ({ page, db }) => {
    const aliceId = await db.getUserId(ALICE.username);
    const [seeded] = await db.seedPosts(aliceId, 1, {
      content: () => `Accessibility scan target ${Date.now().toString()}`,
    });
    if (!seeded) throw new Error("seedPosts returned no row");

    await page.goto(`/post/${seeded.id}`);
    await expectNoSeriousViolations(page);
  });
});
