import { test, expect } from "../../support/fixtures";

const EN_TITLE = "Home - MyTuums";
const FR_TITLE = "Accueil - MyTuums";

test.describe("locale", () => {
  test("the footer switcher flips EN <-> FR, persists via cookie across reload, and updates <html lang> and the document title", async ({
    page,
    context,
  }) => {
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page).toHaveTitle(EN_TITLE);
    await expect(page.locator("head title")).toHaveCount(1);

    await page.getByRole("button", { name: "Language" }).click();
    await page.getByRole("menuitem", { name: "French" }).click();

    // setLocale() reloads the document by default (atoms/locale.ts) — these
    // are ordinary web-first assertions, so they transparently wait through
    // that reload rather than needing an explicit wait for it.
    await expect(page.locator("html")).toHaveAttribute("lang", "fr");
    await expect(page).toHaveTitle(FR_TITLE);

    const cookies = await context.cookies();
    expect(cookies.find((cookie) => cookie.name === "PARAGLIDE_LOCALE")?.value).toBe("fr");

    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", "fr");
    await expect(page).toHaveTitle(FR_TITLE);

    // Revert to English. The trigger's accessible name is `locale_label`,
    // now rendered in its French value ("Langue"); the menu's own items are
    // labelled in whichever locale is currently active, and `locale_english`
    // happens to be "English" in both catalogues (an untranslated endonym),
    // so this half is stable regardless.
    await page.getByRole("button", { name: "Langue" }).click();
    await page.getByRole("menuitem", { name: "English" }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
  });

  test("legal pages follow the locale — mentions-légales included", async ({ page }) => {
    // The LCEN legal notice is now localized like the other legal pages:
    // English visitors get the English translation of the filing, French
    // visitors the authoritative French text (components/legal/mentions-legales.tsx).
    await page.goto("/mentions-legales");
    await expect(page.getByRole("heading", { name: "Legal Notice" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "1. Site publisher" })).toBeVisible();

    await page.getByRole("button", { name: "Language" }).click();
    await page.getByRole("menuitem", { name: "French" }).click();

    await expect(page.getByRole("heading", { name: "Mentions légales" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "1. Éditeur du site" })).toBeVisible();

    await page.getByRole("button", { name: "Langue" }).click();
    await page.getByRole("menuitem", { name: "English" }).click();
  });
});
