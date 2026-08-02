import { test, expect } from "../../support/fixtures";
import { E2E } from "../../playwright.config";

test.describe("theme", () => {
  test("the theme toggle persists across a reload", async ({ page }) => {
    await page.goto("/");

    await page.getByRole("button", { name: "Toggle theme" }).click();
    await page.getByRole("menuitem", { name: "Dark" }).click();

    // themeClassEffect (atoms/theme.ts) applies the class synchronously on
    // pick, and themeAtom persists it to localStorage.
    await expect(page.locator("html")).toHaveClass(/dark/);

    await page.reload();

    await expect(page.locator("html")).toHaveClass(/dark/);
  });

  test("a fresh context with dark OS emulation and no stored preference starts dark", async ({
    browser,
  }) => {
    // Deliberately not alice's storageState: that one is cookies only (see
    // auth.setup.ts — it's captured via an APIRequestContext, which has no
    // page and therefore no localStorage to snapshot), but an explicitly
    // empty one makes "nothing stored" the point of the test rather than an
    // incidental fact about how the fixture was built.
    const context = await browser.newContext({
      storageState: { cookies: [], origins: [] },
      colorScheme: "dark",
    });
    const page = await context.newPage();

    await page.goto(E2E.webUrl);

    // themeAtom collapses to "system" with nothing in localStorage, and
    // resolvedThemeAtom follows systemThemeAtom, seeded from
    // `matchMedia("(prefers-color-scheme: dark)").matches` — true under this
    // context's emulation.
    await expect(page.locator("html")).toHaveClass(/dark/);

    await context.close();
  });
});
