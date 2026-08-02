import type { Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "../../support/fixtures";
import { ALICE } from "../../support/users";

/**
 * `minor`/`moderate` findings on this app skew toward noise (contrast on
 * decorative elements, landmark nitpicks) rather than something a real user
 * would trip over — filtering to `serious`/`critical` is what keeps this
 * spec a signal worth failing a build over, per the suite's brief.
 */
const SIGNIFICANT_IMPACTS = new Set(["serious", "critical"]);

// Derived from AxeBuilder's own return type rather than imported from
// `axe-core` directly — this package only declares `@axe-core/playwright`
// as a dependency (see package.json), and `axe-core` itself isn't hoisted
// anywhere this workspace's strict pnpm linking would let TypeScript see it.
type Violations = Awaited<ReturnType<AxeBuilder["analyze"]>>["violations"];

function summarize(violations: Violations): string {
  return violations
    .map(
      (violation) =>
        `- [${violation.impact ?? "unknown"}] ${violation.id}: ${violation.help} ` +
        `(${String(violation.nodes.length)} node(s)) — ${violation.helpUrl}`,
    )
    .join("\n");
}

async function expectNoSeriousViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  const significant = results.violations.filter((violation) =>
    SIGNIFICANT_IMPACTS.has(violation.impact ?? ""),
  );

  expect(significant, `Serious/critical accessibility violations:\n${summarize(significant)}`).toEqual(
    [],
  );
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

  test("a profile page has no serious or critical violations", async ({ page }) => {
    await page.goto(`/@${ALICE.username}`);
    await expectNoSeriousViolations(page);
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
