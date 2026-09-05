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

test.describe("hashtag resolution", () => {
  test("a post's resolved tag links to Discover filtered on its game, an unresolved one to search", async ({
    page,
  }) => {
    // The fixture catalog answers `doom`; nothing answers `nothattag`.
    // `.first()`: specs share one database truncated once per run, so a
    // retried attempt posts twice — the newest post's links are first in the
    // feed, and the assertion targets those.
    await page.goto("/");
    const composer = page.getByRole("textbox");
    await composer.fill("Fresh from the #doom vault, not #nothattag");
    await page.getByRole("button", { name: "Post", exact: true }).click();

    const resolved = page.getByRole("link", { name: "#doom", exact: true }).first();
    await expect(resolved).toHaveAttribute("href", "/discover?game=doom");
    await expect(
      page.getByRole("link", { name: "#nothattag", exact: true }).first(),
    ).toHaveAttribute("href", "/search?q=%23nothattag");

    // Hovering the resolved tag previews the game card, with links to the
    // game's page inside it (cover + text share the destination).
    await resolved.hover();
    await expect(page.getByText("Favorites: 0").first()).toBeVisible();
    const viewGame = page.getByRole("link", { name: "View game page" }).first();
    await expect(viewGame).toHaveAttribute("href", "/games/doom");

    // The resolved link lands on Discover filtered to that game.
    await resolved.click();
    await expect(page).toHaveURL(/\/discover\?game=doom/);
    await expect(page.getByText("Posts about DOOM")).toBeVisible();
  });

  test("the composer's tag popover completes a partial tag with the catalog's key", async ({
    page,
  }) => {
    await page.goto("/");
    const composer = page.getByRole("textbox");
    // Typed character by character: completion keys off the caret's live
    // position, and typing leaves it right after the partial tag.
    await composer.click();
    await composer.pressSequentially("playing #do");

    // "do" matches both DOOM and worldofwarcraft (a substring of the key),
    // and popularity ranks WoW first — the issue's own `#wow` story. The
    // assertion follows the top suggestion, whichever the fixture ranks.
    const listbox = page.getByRole("listbox", { name: "Suggested games" });
    await expect(listbox).toBeVisible();
    const option = listbox.locator('[role="option"]').first();
    const offeredKey = await option.locator("text=/^#/").textContent();
    expect(offeredKey).toMatch(/^#[a-z0-9]+$/);

    await option.click();
    await expect(composer).toHaveValue(`playing ${offeredKey}`);
  });
});
