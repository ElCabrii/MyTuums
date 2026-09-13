import { expect, test } from "../../support/fixtures";

test.use({ storageState: { cookies: [], origins: [] } });

/**
 * The one property jsdom cannot prove: a real browser emits no analytics event
 * before opt-in, remembers refusal, and blocks the consent-gated Zaraz action
 * again after withdrawal. This runs in the dedicated analytics project.
 */
test("refusal blocks every analytics request before consent and after withdrawal", async ({
  page,
}) => {
  const pageViews: string[] = [];
  await page.addInitScript(() => {
    Reflect.set(window, "zaraz", {
      consent: { APIReady: true, set() {} },
      track(eventName: string) {
        if (eventName === "MyTuumsPageview")
          void fetch("/__e2e-zaraz-pageview", { method: "POST" });
      },
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
  expect(pageViews).toEqual([]);

  await page.reload();
  await expect(banner).toBeHidden();
  expect(pageViews).toEqual([]);

  await page.getByRole("button", { name: "Manage analytics" }).click();
  await banner.getByRole("button", { name: "Accept analytics" }).click();
  await expect.poll(() => pageViews.length).toBe(1);

  await page.getByRole("button", { name: "Manage analytics" }).click();
  await banner.getByRole("button", { name: "Refuse analytics" }).click();
  const pageViewsBeforeReload = pageViews.length;

  await page.reload();
  await expect(banner).toBeHidden();
  expect(pageViews).toHaveLength(pageViewsBeforeReload);
});
