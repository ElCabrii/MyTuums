import { test, expect } from "../../support/fixtures";
import { uniqueUser } from "../../support/users";

test.describe("search", () => {
  test("typing shows user and post suggestions; Enter lands on the /search results page", async ({
    page,
    db,
  }) => {
    // The marker is both the display name and the post content so one typed
    // query matches both rows at once. The content carries a suffix past the
    // marker so the post option stays textually distinct from the user option
    // (whose row shows the marker in the avatar alt and the name).
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
    // Rows are role="option" links, and an option's accessible name is the
    // avatar alt + name + handle/content concatenated — so match on the piece
    // each row alone shows: only the user row renders a handle, only the post
    // row renders the content.
    await expect(
      listbox.getByRole("option", { name: new RegExp(`@${searcher.username}`) }),
    ).toBeVisible();
    await expect(listbox.getByRole("option", { name: new RegExp(post.content) })).toBeVisible();

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

  test("clicking a suggested user row opens that profile", async ({ page, db }) => {
    const marker = `Clickme${Date.now().toString()}`;
    const searcher = await db.createUser({ ...uniqueUser("clickme"), name: marker });

    await page.goto("/");
    await page.getByRole("combobox", { name: "Search" }).fill(marker);

    const listbox = page.getByRole("listbox", { name: "Search suggestions" });
    await expect(listbox).toBeVisible();

    await listbox.getByRole("option", { name: new RegExp(`@${searcher.username}`) }).click();

    await expect(page).toHaveURL(`/@${searcher.username}`);
    await expect(page.getByRole("heading", { name: marker })).toBeVisible();
  });
});
