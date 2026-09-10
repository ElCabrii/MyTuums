import { expect, test } from "../../support/fixtures";

test.use({ storageState: { cookies: [], origins: [] } });

/**
 * The one property jsdom cannot prove: a real browser makes no third-party
 * request before opt-in, remembers refusal, and blocks the tag again after a
 * later withdrawal. This runs in the dedicated analytics Playwright project,
 * whose Vite process alone receives a placeholder measurement id.
 */
test("refusal blocks every GA request before consent and after withdrawal", async ({ page }) => {
  const googleRequests: string[] = [];
  await page.route("https://www.googletagmanager.com/**", async (route) => {
    googleRequests.push(route.request().url());
    await route.fulfill({ status: 200, contentType: "application/javascript", body: "" });
  });

  await page.goto("/login");

  const banner = page.getByRole("region", { name: "Analytics preferences" });
  await expect(banner).toBeVisible();
  await banner.getByRole("button", { name: "Refuse analytics" }).click();
  await expect(banner).toBeHidden();
  expect(googleRequests).toEqual([]);

  await page.reload();
  await expect(banner).toBeHidden();
  expect(googleRequests).toEqual([]);

  await page.getByRole("button", { name: "Manage analytics" }).click();
  await banner.getByRole("button", { name: "Accept analytics" }).click();
  await expect.poll(() => googleRequests.length).toBe(1);

  await page.getByRole("button", { name: "Manage analytics" }).click();
  await banner.getByRole("button", { name: "Refuse analytics" }).click();
  const requestsBeforeReload = googleRequests.length;

  await page.reload();
  await expect(banner).toBeHidden();
  expect(googleRequests).toHaveLength(requestsBeforeReload);
});
