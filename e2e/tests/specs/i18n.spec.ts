import { test, expect } from "../../support/fixtures";

const EN_TITLE = "MyTuums — Social Media for Gamers";
const FR_TITLE = "MyTuums — Le réseau social des gamers";

test.describe("locale", () => {
  test("the footer switcher flips EN <-> FR, persists via cookie across reload, and updates <html lang> and the document title", async ({
    page,
    context,
  }) => {
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page).toHaveTitle(EN_TITLE);

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

  test("/mentions-legales stays French in both locales", async ({ page }) => {
    // The mandatory LCEN legal notice — addressed to French readers and
    // authorities, not app copy (see components/legal/mentions-legales.tsx)
    // — so it deliberately does not follow the footer's locale switch.
    // Comment kept here too so nobody "fixes" it into a translated page.
    await page.goto("/mentions-legales");
    await expect(page.getByRole("heading", { name: "Mentions légales" })).toBeVisible();

    await page.getByRole("button", { name: "Language" }).click();
    await page.getByRole("menuitem", { name: "French" }).click();

    await expect(page.getByRole("heading", { name: "Mentions légales" })).toBeVisible();

    // Revert.
    await page.getByRole("button", { name: "Langue" }).click();
    await page.getByRole("menuitem", { name: "English" }).click();
  });
});
