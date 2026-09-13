import { expect, test } from "../../support/fixtures";

test.use({ storageState: { cookies: [], origins: [] } });

/**
 * The one property jsdom cannot prove: a real browser makes no third-party
 * request before opt-in, remembers refusal, and blocks the consent-gated
 * Zaraz action again after withdrawal. This runs in the dedicated analytics
 * Playwright project.
 */
test("refusal blocks every analytics request before consent and after withdrawal", async ({
  page,
}) => {
  const zarazScripts: string[] = [];
  const pageViews: string[] = [];
  await page.route("**/cdn-cgi/zaraz/i.js", async (route) => {
    zarazScripts.push(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: `
        window.zaraz = {
          consent: { APIReady: true, set() {} },
          track(eventName) {
            if (eventName === "MyTuumsPageview") fetch("/__e2e-zaraz-pageview", { method: "POST" });
          }
        };
        document.dispatchEvent(new Event("zarazConsentAPIReady"));
      `,
    });
  });
  await page.route("**/__e2e-zaraz-pageview", async (route) => {
    pageViews.push(route.request().url());
    await route.fulfill({ status: 204 });
  });

  await page.goto("/login");

  const banner = page.getByRole("region", { name: "Analytics preferences" });
  await expect(banner).toBeVisible();
  await banner.getByRole("button", { name: "Refuse analytics" }).click();
  await expect(banner).toBeHidden();
  expect(zarazScripts).toEqual([]);
  expect(pageViews).toEqual([]);

  await page.reload();
  await expect(banner).toBeHidden();
  expect(zarazScripts).toEqual([]);
  expect(pageViews).toEqual([]);

  await page.getByRole("button", { name: "Manage analytics" }).click();
  await banner.getByRole("button", { name: "Accept analytics" }).click();
  await expect.poll(() => zarazScripts.length).toBe(1);
  await expect.poll(() => pageViews.length).toBe(1);

  await page.getByRole("button", { name: "Manage analytics" }).click();
  await banner.getByRole("button", { name: "Refuse analytics" }).click();
  const scriptsBeforeReload = zarazScripts.length;
  const pageViewsBeforeReload = pageViews.length;

  await page.reload();
  await expect(banner).toBeHidden();
  expect(zarazScripts).toHaveLength(scriptsBeforeReload);
  expect(pageViews).toHaveLength(pageViewsBeforeReload);
});
