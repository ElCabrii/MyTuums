import { ALICE } from "../../support/users";
import { test, expect } from "../../support/fixtures";

test.describe("theme", () => {
  test("the theme toggle persists across a reload", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("button", { name: "Toggle theme" })).toHaveCount(0);
    await page.getByRole("button", { name: ALICE.name }).click();
    await page.getByRole("menuitem", { name: "Toggle theme" }).click();
    await page.getByRole("menuitem", { name: "Dark" }).click();

    // themeClassEffect (atoms/theme.ts) applies the class synchronously on
    // pick, and themeAtom persists it to localStorage.
    await expect(page.locator("html")).toHaveClass(/dark/);

    await page.reload();

    await expect(page.locator("html")).toHaveClass(/dark/);
  });
});
