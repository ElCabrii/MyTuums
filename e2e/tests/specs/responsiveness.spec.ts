import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../../support/fixtures";
import { ALICE, uniqueUser } from "../../support/users";

async function expectNoPageOverflow(page: Page) {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth))
    .toBeLessThanOrEqual(1);
}

async function expectInsideViewport(locator: Locator, page: Page) {
  await expect(locator).toBeVisible();
  await expect
    .poll(async () => {
      const box = await locator.boundingBox();
      const viewport = page.viewportSize();
      return (
        !!box &&
        !!viewport &&
        box.x >= 0 &&
        box.y >= 0 &&
        box.x + box.width <= viewport.width + 1 &&
        box.y + box.height <= viewport.height + 1
      );
    })
    .toBe(true);
}

test("issue 352: Games sorts and privacy table stay inside a 320px document in both locales", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 740 });
  for (const locale of ["en", "fr"]) {
    await page
      .context()
      .addCookies([{ name: "PARAGLIDE_LOCALE", value: locale, domain: "localhost", path: "/" }]);
    await page.goto("/games");
    const lastSort = page.getByRole("button", {
      name: locale === "en" ? "Most favorited" : "Les plus favoris",
      exact: true,
    });
    const sorts = page.locator('[data-slot="segmented-control"]');
    await expect
      .poll(() => sorts.evaluate((element) => element.scrollWidth > element.clientWidth))
      .toBe(true);
    const tops = await sorts
      .getByRole("button")
      .evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().top));
    expect(new Set(tops).size).toBe(1);
    await lastSort.scrollIntoViewIfNeeded();
    await expectInsideViewport(lastSort, page);
    await lastSort.click();
    await expect(page).toHaveURL(/sort=favorites/);
    await expectNoPageOverflow(page);
    await page.goto("/privacy");
    await expect(page.getByRole("table")).toBeVisible();
    await expectNoPageOverflow(page);
  }
});

test("issue 352: long profile names wrap without widening phone, tablet or desktop pages", async ({
  page,
  db,
}) => {
  const name = "W".repeat(80);
  const target = await db.createUser({ ...uniqueUser("longlayout"), name });
  await page.goto(`/@${target.username}`);
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  for (const width of [320, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expectNoPageOverflow(page);
  }
});

test("issue 352: long-author quotes scroll within short viewports and keep submission reachable", async ({
  page,
  db,
}) => {
  const target = await db.createUser({ ...uniqueUser("quotelayout"), name: "W".repeat(80) });
  const [post] = await db.seedPosts(target.id, 1, {
    content: () => Array.from({ length: 20 }, (_, i) => `Line ${i + 1}: audit`).join("\n"),
  });
  if (!post) throw new Error("Missing quote fixture");
  await page.setViewportSize({ width: 740, height: 320 });
  await page.goto(`/post/${post.id}`);
  await page.getByRole("button", { name: "Repost this post" }).click();
  await page.getByRole("menuitem", { name: "Quote", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expectInsideViewport(dialog, page);
  await dialog.getByRole("textbox").fill("A reachable quote");
  const submit = dialog.getByRole("button", { name: "Quote", exact: true });
  await submit.scrollIntoViewIfNeeded();
  await expectInsideViewport(submit, page);
  await expectNoPageOverflow(page);
  await submit.click();
  await expect(dialog).toBeHidden();
});

test("mobile navigation reaches all four destinations and exposes moderation only to authorized viewers", async ({
  page,
  bobPage,
}) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto("/");
  const navigation = page.getByRole("navigation", { name: "Primary navigation" });
  for (const [name, path] of [
    ["Discover", "/discover"],
    ["Games", "/games"],
    ["Profile", `/@${ALICE.username}`],
    ["Home", "/"],
  ]) {
    const link = navigation.getByRole("link", { name, exact: true });
    await expectInsideViewport(link, page);
    await link.click();
    await expect(page).toHaveURL(new RegExp(`${path.replace("/", "\\/")}$`));
    await expect(link).toHaveAttribute("aria-current", "page");
  }
  await expectInsideViewport(
    page.getByRole("banner").getByRole("link", { name: "Moderation", exact: true }),
    page,
  );
  await bobPage.setViewportSize({ width: 320, height: 740 });
  await bobPage.goto("/");
  await expect(
    bobPage.getByRole("banner").getByRole("link", { name: "Moderation", exact: true }),
  ).toHaveCount(0);
});

test("mobile header keeps search between the logo and bell across primary pages", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 740 });
  let headerHeight: number | undefined;
  for (const path of ["/", "/discover", "/games", `/@${ALICE.username}`]) {
    await page.goto(path);
    const header = page.getByRole("banner");
    const search = header.getByRole("combobox", { name: "Search", exact: true });
    await expectInsideViewport(search, page);
    const logoBox = await header.getByRole("link", { name: "MyTuums — Home" }).boundingBox();
    const searchBox = await search.boundingBox();
    const bellBox = await header.locator('a[href="/notifications"]').boundingBox();
    if (!logoBox || !searchBox || !bellBox) throw new Error("Missing header control");
    expect(searchBox.x).toBeGreaterThanOrEqual(logoBox.x + logoBox.width);
    expect(searchBox.x + searchBox.width).toBeLessThanOrEqual(bellBox.x);
    expect(searchBox.y + searchBox.height / 2).toBeCloseTo(bellBox.y + bellBox.height / 2, 0);
    const height = (await header.boundingBox())?.height;
    if (headerHeight === undefined) headerHeight = height;
    expect(height).toBe(headerHeight);
    await expectNoPageOverflow(page);
  }
});

test("profile editing stays available on desktop and mobile, with account settings in the menu", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/@${ALICE.username}`);
  const editProfile = page.getByRole("button", { name: "Edit profile", exact: true });
  const accountMenu = page.getByRole("button", { name: "Account menu", exact: true });
  await expect(editProfile).toBeVisible();
  await expect(accountMenu).toBeHidden();
  await editProfile.click();
  const editor = page.getByRole("dialog", { name: "Edit profile", exact: true });
  await expectInsideViewport(editor, page);
  await editor.getByRole("button", { name: "Close", exact: true }).click();

  await page.setViewportSize({ width: 320, height: 740 });
  await expect(editProfile).toBeVisible();
  await editProfile.click();
  await expectInsideViewport(editor, page);
  await editor.getByRole("button", { name: "Close", exact: true }).click();
  await accountMenu.click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/account$/);
  const categories = page.getByRole("tablist", { name: "Account settings" });
  await expectInsideViewport(categories, page);
  for (const name of ["Account", "Security", "Privacy", "Preferences"]) {
    await expectInsideViewport(page.getByRole("tab", { name, exact: true }), page);
  }
  const categoryBounds = await categories.boundingBox();
  const contentBounds = await page
    .getByRole("tabpanel", { name: "Account", exact: true })
    .boundingBox();
  if (!categoryBounds || !contentBounds) throw new Error("Missing settings navigation or content");
  expect(contentBounds.y).toBeGreaterThanOrEqual(categoryBounds.y + categoryBounds.height);
  await expectNoPageOverflow(page);
});
