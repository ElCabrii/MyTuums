import { test, expect } from "../../support/fixtures";
import { uniqueUser } from "../../support/users";

test.describe("home feed scope", () => {
  test("Global <-> Following changes the feed, persists across reload, and the URL stays /", async ({
    page,
    db,
  }) => {
    const carol = await db.createUser(uniqueUser("carol"));
    const [carolPost] = await db.seedPosts(carol.id, 1, {
      content: () => `Carol's global-only post ${Date.now().toString()}`,
    });
    if (!carolPost) throw new Error("seedPosts returned no row");

    await page.goto("/");
    await expect(page.getByText(carolPost.content, { exact: true })).toBeVisible();

    const feedGroup = page.getByRole("group", { name: "Feed" });
    await feedGroup.getByRole("button", { name: "Following" }).click();

    // Alice follows nobody in this test, so Following is empty of everyone
    // but herself — carol, who she doesn't follow, drops out.
    await expect(page.getByText(carolPost.content, { exact: true })).not.toBeVisible();
    await expect(feedGroup.getByRole("button", { name: "Following" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page).toHaveURL("/");

    await page.reload();

    // feedScopeAtom persists to localStorage (lib/feed-scope.ts) — the choice
    // survives, but `/` never grows a search param for it.
    await expect(
      page.getByRole("group", { name: "Feed" }).getByRole("button", { name: "Following" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(page).toHaveURL("/");
  });

  // A "signed out, only the Global feed is available" test used to live here.
  // The app has no anonymous surface any more (issue #36): `post.list` is
  // `protectedProcedure`, and `use-require-signed-in.ts` bounces a signed-out
  // visitor to `/login` before the feed ever mounts. `like.spec.ts`'s "signed
  // out, the site gate holds a visitor at /login" test already covers that
  // redirect — this one would just be racing it.
});

test.describe("home feed pagination", () => {
  test("load more fetches page 2 without duplicating any post", async ({ page, db }) => {
    // A throwaway author, and their own profile feed rather than the global
    // home feed: the global feed accumulates posts from every other spec in
    // this run (workers are pinned to 1, and the database is only truncated
    // once — see playwright.config.ts and global-setup.ts), so "seed 25,
    // click Load more once, exhausted" would be a fragile assumption there —
    // by the time this spec runs there could easily be a third page from
    // unrelated posts. A fresh author's profile feed is scoped to `authorId`
    // server-side (packages/api/src/posts.ts), so nothing another spec seeds
    // can land in it.
    const author = await db.createUser(uniqueUser("paginator"));
    const marker = `Pagination probe ${Date.now().toString()}`;
    // POST_PAGE_SIZE is 20 (packages/api/src/constants.ts); 25 posts
    // guarantees a second, partial page.
    const seeded = await db.seedPosts(author.id, 25, {
      content: (index) => `${marker} #${String(index + 1)}`,
    });

    await page.goto(`/@${author.username}`);

    const loadMore = page.getByRole("button", { name: "Load more" });
    await expect(loadMore).toBeVisible();
    await loadMore.click();
    // All 25 fit across the two pages this seeds, so the button disappears
    // once page 2 lands — a stand-in for "there was in fact a second fetch".
    await expect(loadMore).toBeHidden();

    // Exact-match, one at a time, rather than one regex sweep: a substring
    // sweep over ancestor `div`s would also match the outer containers whose
    // text happens to include every post's content (they all bubble up to
    // the same feed list), inflating the count without a real duplicate in
    // sight. An exact match only lands on the post's own <p>, so
    // toHaveCount(1) for every seeded post is a direct "no duplicates, none
    // missing" assertion.
    for (const post of seeded) {
      await expect(page.getByText(post.content, { exact: true })).toHaveCount(1);
    }
  });
});
