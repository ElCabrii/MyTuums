import { test, expect } from "../../support/fixtures";
import { uniqueUser } from "../../support/users";

test.describe("search", () => {
  test("typing shows only profile suggestions; Enter lands on the full search results page", async ({
    page,
    db,
  }) => {
    // The marker is both the display name and the post content: typing finds
    // the profile in the typeahead, then the full page finds both sections.
    // The suffix keeps the post text uniquely identifiable there.
    const marker = `Searchprobe${Date.now().toString()}`;
    const searcher = await db.createUser({ ...uniqueUser("searcher"), name: marker });
    const [post] = await db.seedPosts(searcher.id, 1, {
      content: () => `${marker} from the typeahead`,
    });
    if (!post) throw new Error("seedPosts returned no row");

    await page.goto("/");
    // The query fires 300ms after the input settles (the debounce in
    // setSearchQueryAtom) — Playwright auto-waits on the assertions below, so
    // no manual wait is needed.
    await page.getByRole("combobox", { name: "Search" }).fill(marker);

    const listbox = page.getByRole("listbox", { name: "Search suggestions" });
    await expect(listbox).toBeVisible();
    // The typeahead is profile-only even though Enter still opens the full
    // search page, where both the People and Posts sections render.
    await expect(
      listbox.getByRole("option", { name: new RegExp(`@${searcher.username}`) }),
    ).toBeVisible();
    await expect(listbox.getByText(post.content, { exact: true })).toHaveCount(0);

    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(`/search?q=${marker}`);
    await expect(page.getByRole("heading", { name: `Results for “${marker}”` })).toBeVisible();
    await expect(page.getByRole("heading", { name: "People" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Posts" })).toBeVisible();
    // The results are real, not just headings: exact match lands only on the
    // seeded post's own text in the Posts section. Scoping to the section (not
    // the whole page) keeps a lingering typeahead suggestion — a focus return
    // reopening the non-empty query on the destination page — from becoming a
    // second strict-mode match.
    const postsSection = page.getByRole("region", { name: "Posts" });
    await expect(postsSection.getByText(post.content, { exact: true })).toBeVisible();
  });
});
