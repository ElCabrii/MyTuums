import { test, expect } from "../../support/fixtures";
import { ALICE } from "../../support/users";

const COMPOSER_PLACEHOLDER = "Share a gaming update, clip, or tournament result...";
const REPLY_PLACEHOLDER = "Post your reply...";

test.describe("composing a post", () => {
  test("posting from / adds the new post to the top of the feed", async ({ page, db }) => {
    const aliceId = await db.getUserId(ALICE.username);
    const [older] = await db.seedPosts(aliceId, 1, {
      content: () => `Existing feed post ${Date.now().toString()}`,
    });
    if (!older) throw new Error("seedPosts returned no row");

    await page.goto("/");

    const fresh = `Brand new feed post ${Date.now().toString()}`;
    await page.getByPlaceholder(COMPOSER_PLACEHOLDER).fill(fresh);
    await page.getByRole("button", { name: "Post", exact: true }).click();

    const freshLocator = page.getByText(fresh, { exact: true });
    const olderLocator = page.getByText(older.content, { exact: true });
    await expect(freshLocator).toBeVisible();
    await expect(olderLocator).toBeVisible();

    const [freshBox, olderBox] = await Promise.all([
      freshLocator.boundingBox(),
      olderLocator.boundingBox(),
    ]);
    if (!freshBox || !olderBox) throw new Error("expected both posts to have a layout box");
    expect(freshBox.y).toBeLessThan(olderBox.y);
  });

  test("the counter goes negative past 500 characters and disables submit", async ({ page }) => {
    await page.goto("/");
    const textarea = page.getByPlaceholder(COMPOSER_PLACEHOLDER);

    await textarea.fill("x".repeat(505));

    // POST_MAX_LENGTH is 500 (packages/api/src/constants.ts); 505 characters
    // leaves a remaining count of -5.
    await expect(page.getByText("-5", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Post", exact: true })).toBeDisabled();
  });

  test("whitespace-only content cannot be submitted", async ({ page }) => {
    await page.goto("/");
    await page.getByPlaceholder(COMPOSER_PLACEHOLDER).fill("     ");

    // ComposerForm trims before checking length (components/composer-form.tsx),
    // so an all-whitespace draft never satisfies canSubmit.
    await expect(page.getByRole("button", { name: "Post", exact: true })).toBeDisabled();
  });

  test("the home draft survives a page reload", async ({ page }) => {
    await page.goto("/");
    const draft = `Unsent home draft ${Date.now().toString()}`;
    await page.getByPlaceholder(COMPOSER_PLACEHOLDER).fill(draft);

    await page.reload();

    // composerDraftAtom persists to localStorage (atoms/composer.ts).
    await expect(page.getByPlaceholder(COMPOSER_PLACEHOLDER)).toHaveValue(draft);
  });

  test("a reply draft on /post/$id does NOT survive a reload", async ({ page, db }) => {
    const aliceId = await db.getUserId(ALICE.username);
    const [seeded] = await db.seedPosts(aliceId, 1, {
      content: () => `Reply draft target ${Date.now().toString()}`,
    });
    if (!seeded) throw new Error("seedPosts returned no row");

    await page.goto(`/post/${seeded.id}`);
    const draft = `Unsent reply draft ${Date.now().toString()}`;
    await page.getByPlaceholder(REPLY_PLACEHOLDER).fill(draft);

    await page.reload();

    // The contrast with the test above is the point: replyDraftAtomFamily is
    // deliberately in-memory (atoms/reply-composer.ts) — a family of
    // localStorage keys, one per post ever replied to, would have nothing
    // able to evict them, so this one empties on reload instead of surviving it.
    await expect(page.getByPlaceholder(REPLY_PLACEHOLDER)).toHaveValue("");
  });
});
