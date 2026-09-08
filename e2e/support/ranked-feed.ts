import type { Page } from "@playwright/test";
import { expect } from "./fixtures";

/**
 * Waits for a post's unique text to land in a ranked home feed (issue #305),
 * paging forward as needed.
 *
 * Ranked order is score-based over a database shared by every spec in the run
 * (workers are pinned to 1 and the tables are truncated once — see
 * playwright.config.ts), so a new post has no first-page guarantee: its
 * freshness ties with every other recent post inside the same hourly bucket,
 * and ties break on the random post id. A `Refresh` — or a first visit, which
 * mints the snapshot — puts the post in the order; this pages that order
 * until the text lands. Fifteen pages cover well past the run's seed volume;
 * an exhausted list, or the bound, fails on the final assertion.
 */
export async function expectRankedPostText(page: Page, text: string): Promise<void> {
  const postText = page.getByText(text, { exact: true });
  const loadMore = page.getByRole("button", { name: "Load more" });
  // `.first()` keeps the `or` strict-safe when both are already visible.
  await expect(postText.or(loadMore).first()).toBeVisible({ timeout: 15_000 });
  for (let i = 0; i < 15 && (await postText.count()) === 0; i++) {
    if ((await loadMore.count()) === 0) break;
    // While the next page is in flight the button is disabled, so a recount
    // that still misses blocks on the following click until the list settles.
    await loadMore.click();
  }
  await expect(postText).toBeVisible({ timeout: 10_000 });
}
