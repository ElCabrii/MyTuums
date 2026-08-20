import { expect, test } from "../../support/fixtures";
import { uniqueUser } from "../../support/users";

/**
 * The legal consent gate (issues #157, #158).
 *
 * `/register` collects the acceptance in its own box, but that is the one
 * creation path that has somewhere to put it. An OAuth or passkey sign-up
 * bounces out to a provider and comes back already signed up, so those
 * accounts arrive with no acceptance recorded — as do accounts created before
 * the record existed, and anyone whose acceptance names a superseded version.
 * They are held by a dialog on whatever page they land on, until they accept.
 *
 * These specs drive that state directly (`db.clearLegalConsent`) rather than
 * through a real provider round trip, which would need Google's consent
 * screen and live credentials. Same reasoning as the `/welcome` specs next
 * door: what the gate guards is the *unset columns*, not the path that left
 * them that way.
 */
test.use({ storageState: { cookies: [], origins: [] } });

/** Signs up, strips the recorded consent, and signs back in — the OAuth arrival state. */
async function signedInWithoutConsent(
  page: import("@playwright/test").Page,
  db: typeof import("../../support/db"),
) {
  const account = uniqueUser("noconsent");
  const created = await db.createUser(account);
  await db.clearLegalConsent(created.id);

  await page.goto("/login");
  await page.getByLabel("Username or Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("main").getByRole("button", { name: "Log in" }).click();

  return account;
}

test.describe("legal consent gate", () => {
  test("holds an account that never accepted, on whatever page it lands", async ({ page, db }) => {
    await signedInWithoutConsent(page, db);

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("checkbox")).not.toBeChecked();
  });

  test("keeps holding after a navigation — the gate is not a one-page banner", async ({
    page,
    db,
  }) => {
    await signedInWithoutConsent(page, db);
    await expect(page.getByRole("dialog")).toBeVisible();

    await page.goto("/settings/account");

    await expect(page.getByRole("dialog")).toBeVisible();
  });

  test("leaves the documents readable, so the ask can be read before it is answered", async ({
    page,
    db,
  }) => {
    await signedInWithoutConsent(page, db);
    await expect(page.getByRole("dialog")).toBeVisible();

    // The dialog cannot be dismissed and its links open in a new tab, so the
    // documents themselves must not be behind it.
    await page.goto("/terms");

    await expect(page.getByRole("dialog")).toBeHidden();
  });

  test("accepting records the consent and releases the app", async ({ page, db }) => {
    await signedInWithoutConsent(page, db);

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    const accept = dialog.getByRole("button", { name: "Accept" });
    await expect(accept).toBeDisabled();

    await dialog.getByRole("checkbox").check();
    await expect(accept).toBeEnabled();
    await accept.click();

    await expect(dialog).toBeHidden();

    // It has to survive a reload: a gate that only closes in memory would
    // reopen on the next visit, and the record is the whole point.
    await page.reload();
    await expect(page.getByRole("dialog")).toBeHidden();
  });
});
