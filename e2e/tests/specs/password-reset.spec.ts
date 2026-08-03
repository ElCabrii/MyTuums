import { test, expect } from "../../support/fixtures";
import { createUser, getUserId, passwordResetTokenFor } from "../../support/db";
import { uniqueUser } from "../../support/users";
import { E2E } from "../../playwright.config";

// Signed out for the whole file, like auth.spec.ts — a reset flow is by
// definition for people who cannot sign in.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe("password reset", () => {
  test("the full flow: request a link, reset the password, sign in with the new one", async ({
    page,
  }) => {
    // Never reset alice/bob — the suite's storage states and passwords depend
    // on them — so this flow drives a throwaway account instead.
    const user = uniqueUser("pwreset");
    await createUser(user);

    await page.goto("/forgot-password");
    await page.getByLabel("Email Address").fill(user.email);
    await page.getByRole("main").getByRole("button", { name: "Send reset link" }).click();

    await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();

    // The link the email would carry. `BETTER_AUTH_URL` is the server origin,
    // so the browser validates the token there and is 302'd to the web app —
    // the full chain: token validation, absolute redirect, trustedOrigins.
    const userId = await getUserId(user.username);
    const token = await passwordResetTokenFor(userId);
    const callbackURL = encodeURIComponent(`${E2E.webUrl}/reset-password`);
    await page.goto(`${E2E.serverUrl}/api/auth/reset-password/${token}?callbackURL=${callbackURL}`);
    await expect(page).toHaveURL(/\/reset-password\?token=/);

    await page.getByLabel("New Password").fill("fresh-e2e-password-1");
    await page.getByLabel("Confirm Password").fill("fresh-e2e-password-1");
    await page.getByRole("main").getByRole("button", { name: "Reset password" }).click();

    await expect(page.getByRole("heading", { name: "Password updated" })).toBeVisible();

    // The success button signs the (nonexistent) stale session out first, then
    // lands on /login; scoped to <main> because the header renders its own
    // "Log in" button with the identical accessible name.
    await page.getByRole("main").getByRole("button", { name: "Log in" }).click();
    await page.getByLabel("Username or Email").fill(user.email);
    await page.getByLabel("Password", { exact: true }).fill("fresh-e2e-password-1");
    await page.getByRole("main").getByRole("button", { name: "Log in" }).click();

    // useRedirectWhenSignedIn is the whole post-sign-in redirect; landing on
    // the profile proves the new password actually signs in.
    await expect(page).toHaveURL(new RegExp(`/@${user.username}$`));
  });

  test("an invalid or expired link lands on the invalid-link panel, which offers a fresh request", async ({
    page,
  }) => {
    const callbackURL = encodeURIComponent(`${E2E.webUrl}/reset-password`);
    await page.goto(
      `${E2E.serverUrl}/api/auth/reset-password/not-a-real-token?callbackURL=${callbackURL}`,
    );

    await expect(page).toHaveURL(/reset-password\?error=INVALID_TOKEN/);
    await expect(
      page.getByRole("heading", { name: "This link is invalid or expired" }),
    ).toBeVisible();

    await page.getByRole("main").getByRole("button", { name: "Request a new link" }).click();
    await expect(page).toHaveURL(/\/forgot-password$/);
  });

  test("the login page links to the forgot-password page", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("link", { name: "Forgot password?" }).click();
    await expect(page).toHaveURL(/\/forgot-password$/);
  });
});
