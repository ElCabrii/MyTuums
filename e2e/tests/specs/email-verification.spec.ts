import { test, expect } from "../../support/fixtures";
import { emailVerificationLinkFor } from "../../support/db";
import { uniqueUser } from "../../support/users";
import { E2E } from "../../playwright.config";

// Signed out for the whole file: every state this spec exercises — pending,
// rejected sign-in, a bad link, and the moment a good link lands — belongs to
// someone who has not yet proved their email, so no storage state is wanted.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe("email verification gate (issue #172)", () => {
  test("a fresh sign-up lands on the check-your-email screen, can resend, and cannot reach the app", async ({
    page,
  }) => {
    const username = `e2everify${Date.now().toString(36)}`;

    await page.goto("/register");
    await page.getByLabel("Username").fill(username);
    await page.getByLabel("Display Name").fill("Pending Fixture");
    await page.getByLabel("Email Address").fill(`${username}@example.test`);
    await page.getByLabel("Password", { exact: true }).fill("a-fresh-password-1");
    await page.getByLabel("Confirm Password").fill("a-fresh-password-1");
    await page.getByLabel("Date of Birth").fill("1995-01-01");
    await page.getByRole("checkbox", { name: /I have read and agree/ }).check();
    await page.getByRole("main").getByRole("button", { name: "Register" }).click();

    // requireEmailVerification: sign-up creates the account and sends the link
    // but issues NO session, so the person lands on /verify-email, not /welcome.
    await expect(page).toHaveURL(/\/verify-email$/);
    await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();

    // The pending screen offers a resend — the recovery path for a link that
    // never arrived. `verifyEmailAtom` holds the address just entered, so the
    // button is here; a reload would drop it. The atom accepts the request
    // unconditionally and reports the generic "if an account exists" copy.
    await page.getByRole("button", { name: "Resend verification link" }).click();
    await expect(page.getByText(/we've sent a new verification link/i)).toBeVisible();

    // No session means the app is unreachable: a protected page bounces to
    // /login (with the destination preserved) rather than rendering for someone
    // who has not proved their email.
    await page.goto("/discover");
    await expect(page).toHaveURL(/\/login(\?redirect=.*)?$/);
  });

  test("signing in with the correct password is rejected while unverified and re-sends the link", async ({
    page,
    db,
  }) => {
    // Seeded unverified on purpose — `{ verifyEmail: false }` leaves the column
    // alone, reproducing a password sign-up that has not yet clicked its link.
    const account = uniqueUser("unverified");
    await db.createUser(account, { verifyEmail: false });

    await page.goto("/login");
    await page.getByLabel("Username or Email").fill(account.email);
    await page.getByLabel("Password").fill(account.password);
    await page.getByRole("main").getByRole("button", { name: "Log in" }).click();

    // A correct password on an unverified account produces no session: Better
    // Auth rejects the sign-in with EMAIL_NOT_VERIFIED and `sendOnSignIn`
    // re-sends the verification email, so /login navigates to the
    // check-your-email screen rather than a "try again" banner.
    await expect(page).toHaveURL(/\/verify-email$/);
    await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();

    // Still signed out: the recovery screen did not mint a session either.
    await page.goto("/discover");
    await expect(page).toHaveURL(/\/login(\?redirect=.*)?$/);
  });

  test("an invalid verification link lands on the invalid-link panel", async ({ page }) => {
    // The redirect target every real link carries; a bogus token makes the
    // server 302 to `<callbackURL>?error=INVALID_TOKEN` instead of signing in.
    const callbackURL = encodeURIComponent(`${E2E.webUrl}/verify-email`);
    await page.goto(`${E2E.serverUrl}/api/auth/verify-email?token=not-a-real-token&callbackURL=${callbackURL}`);

    await expect(page).toHaveURL(/\/verify-email\?error=/);
    await expect(
      page.getByRole("heading", { name: "This link is invalid or expired" }),
    ).toBeVisible();

    // The panel points back at sign-in — the recovery path for a bad link,
    // since signing in re-sends the verification email via `sendOnSignIn`.
    await page.getByRole("main").getByRole("button", { name: "Back to sign in" }).click();
    await expect(page).toHaveURL(/\/login$/);
  });

  test("completing verification signs the account in and grants access", async ({ page, db }) => {
    const account = uniqueUser("verifying");
    await db.createUser(account, { verifyEmail: false });

    // The link a real verification email would carry, re-minted with the same
    // secret the server signs them with (see `emailVerificationLinkFor`).
    // Visiting it verifies the email, and `autoSignInAfterVerification` mints a
    // session and redirects to /verify-email, where `useRedirectWhenSignedIn`
    // sends the now-complete account to its profile.
    await page.goto(emailVerificationLinkFor(account.email, `${E2E.webUrl}/verify-email`));

    await expect(page).toHaveURL(new RegExp(`/@${account.username}$`));

    // The session is real: a protected page renders instead of bouncing to
    // /login, which is the whole point — verification is what unlocks the app.
    await page.goto("/discover");
    await expect(page).toHaveURL(/\/discover$/);
  });
});