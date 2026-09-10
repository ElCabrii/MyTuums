import webPackage from "../../../apps/web/package.json" with { type: "json" };
import { test, expect } from "../../support/fixtures";

test.use({ storageState: { cookies: [], origins: [] }, showReleaseNotes: true });

test("the release popup survives a version bump without obstructing later visits", async ({
  page,
}) => {
  await page.goto("/login");

  const dialog = page.getByRole("dialog", { name: `What's new in v${webPackage.version}` });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("region", { name: "Release notes" })).toContainText(
    "Welcome to Beta!",
  );
  await dialog.getByRole("button", { name: "Got it" }).click();
  await page.reload();

  await expect(page.getByRole("heading", { name: "Welcome Back" })).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("textbox", { name: "USERNAME OR EMAIL" }).fill("returning-player");
  await expect(page.getByRole("textbox", { name: "USERNAME OR EMAIL" })).toHaveValue(
    "returning-player",
  );
});
