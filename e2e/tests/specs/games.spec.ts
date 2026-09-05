import { expect, test } from "@playwright/test";

// The game directory is the app's second public page family (issue #314):
// these specs drive it as the anonymous visitor it was opened for. The
// catalog comes from the committed fixture seeded by global-setup — a
// stable, known set (its contract is pinned in packages/api's
// games-fixture.test.ts), so the specs can name games outright.

test.use({ storageState: { cookies: [], origins: [] } });

test.describe("game directory", () => {
  test("the hub renders the seeded catalog for a signed-out visitor", async ({ page }) => {
    await page.goto("/games");

    await expect(page.getByRole("heading", { name: "Games" })).toBeVisible();
    // Rank 1 of the fixture.
    await expect(page.getByRole("link", { name: /League of Legends/ })).toBeVisible();
  });

  test("a game page renders strictly game data, still signed out", async ({ page }) => {
    // The fixture's DOOM 1993/2016 collision pair: the lower id holds the
    // bare hashtag key and the plain `doom` slug.
    await page.goto("/games/doom");

    await expect(page.getByRole("heading", { name: "DOOM", exact: true })).toBeVisible();
    await expect(page.getByText("Released in 1993")).toBeVisible();
    await expect(page.getByText("Favorites: 0")).toBeVisible();
    // Q22's field list includes genres and platforms; the fixture seeds both
    // for this game. Exact match — the summary also contains the word.
    await expect(page.getByText("Shooter", { exact: true })).toBeVisible();
  });

  test("the grid's card navigates to its game page", async ({ page }) => {
    await page.goto("/games");
    await page.getByRole("link", { name: /Hades/ }).click();

    await expect(page).toHaveURL(/\/games\/hades$/);
    await expect(page.getByRole("heading", { name: "Hades", exact: true })).toBeVisible();
  });

  test("the upcoming sort lists unreleased games most-wanted first", async ({ page }) => {
    await page.goto("/games?sort=upcoming");

    // The fixture's upcoming shelf: The Elder Scrolls VI (5120 wants) leads.
    await expect(page.getByText("The Elder Scrolls VI")).toBeVisible();
    await expect(page.getByText("5120 wants")).toBeVisible();
  });
});
