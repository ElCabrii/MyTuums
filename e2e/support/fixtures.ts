import { test as base, type BrowserContext, type Page } from "@playwright/test";
import { E2E } from "../playwright.config";
import * as db from "./db";

type Fixtures = {
  /** A page authenticated as bob — for two-viewer scenarios (like/follow sync, DM-style checks). */
  bobPage: Page;
  /** A page with no cookies at all — the signed-out reading of every spec. */
  signedOutPage: Page;
  /** The seeding helpers from ./db, so specs don't import that module directly. */
  db: typeof db;
  /** Seeds refusal in unrelated browser specs so the consent banner stays scoped to its own project. */
  analyticsRefusal: void;
};

const ANALYTICS_CONSENT_KEY = "my-tuums.analytics-consent";

async function seedAnalyticsRefusal(context: BrowserContext | Page): Promise<void> {
  await context.addInitScript((storageKey) => {
    localStorage.setItem(storageKey, JSON.stringify({ decision: "denied", decidedAt: Date.now() }));
  }, ANALYTICS_CONSENT_KEY);
}

/**
 * The suite's extended test handle: adds the `bobPage` and `signedOutPage`
 * pages plus the `db` seeding helpers to Playwright's default fixtures.
 */
export const test = base.extend<Fixtures>({
  bobPage: async ({ browser }, use, testInfo) => {
    const context = await browser.newContext({ storageState: E2E.storageStateFor("bob") });
    if (testInfo.project.name !== "analytics") await seedAnalyticsRefusal(context);
    const page = await context.newPage();
    await use(page);
    await context.close();
  },

  signedOutPage: async ({ browser }, use, testInfo) => {
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    if (testInfo.project.name !== "analytics") await seedAnalyticsRefusal(context);
    const page = await context.newPage();
    await use(page);
    await context.close();
  },

  // No fixture dependencies of its own. Playwright requires the literal `{}`
  // destructuring pattern here — it statically parses a fixture function's
  // source to work out what it depends on, so a renamed/non-destructured
  // parameter breaks that detection ("First argument must use the object
  // destructuring pattern").
  // eslint-disable-next-line no-empty-pattern -- required by Playwright, see above
  db: async ({}, use) => {
    await use(db);
  },

  analyticsRefusal: [
    async ({ page }, use, testInfo) => {
      if (testInfo.project.name !== "analytics") await seedAnalyticsRefusal(page);
      await use();
    },
    { auto: true },
  ],
});

export { expect } from "@playwright/test";
