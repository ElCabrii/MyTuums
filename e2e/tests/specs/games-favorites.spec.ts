import { expect, test } from "@playwright/test";

// The favorite journey (issue #314, stage 3), signed in as the project's
// default fixture account (alice). The catalog comes from the committed
// fixture seeded by global-setup, so the slugs are stable and the count the
// page starts from is zero — the truncate in global-setup wiped every
// favorite with everything else.

test.describe("game favorites", () => {
  test("favoriting from a game page shows the count and lands on the profile rail", async ({
    page,
  }) => {
    await page.goto("/games/doom");
    await expect(page.getByText("Favorites: 0")).toBeVisible();

    await page.getByRole("button", { name: "Favorite" }).click();

    // The optimistic flip is the whole feedback: the button inverts and the
    // public count ticks, before any round trip.
    await expect(page.getByRole("button", { name: "Unfavorite" })).toBeVisible();
    await expect(page.getByText("Favorites: 1")).toBeVisible();

    // The showcase (Q26): alice's favorites are visible on her own profile —
    // and would be to any other signed-in viewer.
    await page.goto("/@alice");
    await expect(page.getByRole("region", { name: "Favorite games" })).toBeVisible();
    await expect(page.getByRole("link", { name: "DOOM", exact: true })).toBeVisible();

    // And the toggle is reversible.
    await page.goto("/games/doom");
    await page.getByRole("button", { name: "Unfavorite" }).click();
    await expect(page.getByRole("button", { name: "Favorite" })).toBeVisible();
    await expect(page.getByText("Favorites: 0")).toBeVisible();
  });
});
