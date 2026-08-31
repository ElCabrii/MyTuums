import { test, expect } from "../../support/fixtures";
import { ALICE } from "../../support/users";
import { bookmarkButtonFor, postCardWithText } from "../../support/post-card";

/**
 * The page journey (issue #262): save a post from its permalink, reach
 * /bookmarks through the account menu, and remove the save from the page.
 * The idempotency, pagination and tombstone rules are pinned at
 * `packages/api/src/bookmarks.int.test.ts`; this spec proves the assembled
 * journey — the control, the menu entry, the page, and the state the server
 * actually kept.
 */
test.describe("bookmarks", () => {
  test("saving a post from its thread puts it on the bookmarks page, and removing it takes it off", async ({
    page,
    db,
  }) => {
    const aliceId = await db.getUserId(ALICE.username);
    const [seeded] = await db.seedPosts(aliceId, 1, {
      content: () => `Bookmark target ${Date.now().toString()}`,
    });
    if (!seeded) throw new Error("seedPosts returned no row");

    await page.goto(`/post/${seeded.id}`);
    const bookmarkButton = page.getByRole("button", { name: "Bookmark this post" });
    await expect(bookmarkButton).toHaveAttribute("aria-pressed", "false");

    await bookmarkButton.click();
    await expect(page.getByRole("button", { name: "Remove bookmark" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // The account menu is the page's one nav entry — the journey goes through
    // it rather than a direct URL, so a broken menu item fails here, not in
    // some other spec that happens to visit /bookmarks.
    await page.getByTitle(`View profile for ${ALICE.name}`).click();
    await page.getByRole("menuitem", { name: "Bookmarks" }).click();
    await expect(page).toHaveURL(/\/bookmarks$/);
    await expect(postCardWithText(page, seeded.content)).toBeVisible();
    // The saved row carries its own pressed state, so the card on the page
    // offers to remove the save, not add a second one.
    await expect(bookmarkButtonFor(page, seeded.content)).toHaveAttribute("aria-pressed", "true");

    // Removing takes the post off the page on the click itself — the
    // confirmed unbookmark drops the row from the bookmarks feed's cached
    // pages; no reload, no unrelated refetch. There is deliberately no
    // `aria-pressed="false"` step in between: the row disappears on the
    // same success path that would flip it, so that intermediate state is
    // not observable and asserting it only races the removal.
    await bookmarkButtonFor(page, seeded.content).click();
    await expect(postCardWithText(page, seeded.content)).toHaveCount(0);

    // …and the reload proves that was the server's state, not just the
    // optimistic cache.
    await page.reload();
    await expect(postCardWithText(page, seeded.content)).toHaveCount(0);
    await expect(page.getByText("Nothing saved yet.")).toBeVisible();
  });
});
