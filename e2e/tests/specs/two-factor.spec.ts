import { base32 } from "@better-auth/utils/base32";
import { createOTP } from "@better-auth/utils/otp";
import { expect, test } from "../../support/fixtures";
import { emailVerificationLinkFor } from "../../support/db";
import { E2E } from "../../playwright.config";
import { uniqueUser } from "../../support/users";

/**
 * The two ceremonies no cheaper layer can carry out: a real TOTP enrolment
 * followed by a real challenged sign-in, and a passkey registered and used
 * through the browser's own WebAuthn stack.
 *
 * Everything else about two-factor is owned lower down and must not be
 * repeated here — the challenge page's methods, error banner and backup-code
 * dispatch by `apps/web/src/routes/two-factor.test.tsx`, and the server rules
 * (enrolment refused until a code is verified, backup codes single-use,
 * no session before the second factor) by `packages/api/src/auth.int.test.ts`.
 *
 * Both specs sign up their own throwaway account: enabling 2FA on alice would
 * break every other spec's storage state, and a mid-run failure would leave
 * her locked behind a challenge nobody can answer.
 */
test.use({ storageState: { cookies: [], origins: [] } });

/** Signs up a fresh account through the UI and lands on its profile. */
async function signUpFresh(page: import("@playwright/test").Page, prefix: string) {
  const account = uniqueUser(prefix);

  await page.goto("/register");
  await page.getByLabel("Username", { exact: true }).fill(account.username);
  await page.getByLabel("Display Name").fill(account.name);
  await page.getByLabel("Email Address").fill(account.email);
  await page.getByLabel("Password", { exact: true }).fill(account.password);
  await page.getByLabel("Confirm Password").fill(account.password);
  await page.getByLabel("Date of Birth").fill(account.dateOfBirth);
  await page.getByRole("checkbox", { name: /I have read and agree/ }).check();
  await page.getByRole("main").getByRole("button", { name: "Register" }).click();

  // requireEmailVerification (packages/auth): sign-up creates the account and
  // sends the verification link but issues NO session, so the person lands on
  // /verify-email rather than /welcome (issue #172). The post-signup two-factor
  // offer is gone on the password path — a documented tradeoff; 2FA is enrolled
  // from settings in these specs, which is the path that remains.
  await expect(page).toHaveURL(/\/verify-email$/);

  // Complete verification by visiting the link a real email would carry:
  // `autoSignInAfterVerification` mints the session and `useRedirectWhenSignedIn`
  // lands the now-complete account on its profile — the state every test below
  // starts from.
  await page.goto(emailVerificationLinkFor(account.email, `${E2E.webUrl}/verify-email`));
  await expect(page).toHaveURL(new RegExp(`/@${account.username}$`));

  return account;
}

/**
 * Derives a live TOTP code from the enrolment URI, the way an authenticator
 * app does — the same helper the API integration suite uses
 * (packages/api/src/auth.int.test.ts). The `secret` query parameter is
 * base32-encoded, which is what the otpauth:// format specifies, while
 * `createOTP` takes the raw secret.
 */
async function totpFor(totpURI: string): Promise<string> {
  const encoded = new URL(totpURI).searchParams.get("secret");
  if (!encoded) throw new Error(`no secret in TOTP URI: ${totpURI}`);
  const secret = new TextDecoder().decode(base32.decode(encoded));
  return createOTP(secret, { digits: 6, period: 30 }).totp();
}

/**
 * Enables two-factor through the settings UI and returns the TOTP URI the
 * server handed the browser — captured from the enable response, the same
 * bytes the QR code renders.
 */
async function enableTwoFactor(
  page: import("@playwright/test").Page,
  account: ReturnType<typeof uniqueUser>,
) {
  await page.goto("/settings/account");

  await page.getByRole("button", { name: "Turn on" }).click();
  await page.getByLabel("Password", { exact: true }).fill(account.password);

  const enableResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/api/auth/two-factor/enable") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Turn on" }).click();
  // SAFETY: This is Better Auth's two-factor enable response; `totpURI` is
  // checked before use.
  const body = (await (await enableResponse).json()) as { totpURI?: string };
  if (!body.totpURI) throw new Error("two-factor enable response carried no TOTP URI");

  await page.getByLabel("Verification code").fill(await totpFor(body.totpURI));
  await page.getByRole("button", { name: "Confirm" }).click();

  // The section flips to the on-state once the session reports the flag.
  await expect(page.getByText("On. You'll be asked for a code when you sign in.")).toBeVisible();

  return { totpURI: body.totpURI };
}

/** Signs out from the account settings and lands on /login. */
async function signOut(page: import("@playwright/test").Page) {
  // Sign-out lives in the navbar account menu and on /settings/account (issue
  // #282 restored the section); the profile page no longer has its own button.
  // The settings page is one navigation away from anywhere, so sign out there.
  await page.goto("/settings/account");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
}

/** Signs in with the password; a 2FA account lands on the /two-factor challenge. */
async function signInWithPassword(
  page: import("@playwright/test").Page,
  account: ReturnType<typeof uniqueUser>,
) {
  await page.getByLabel("Username or Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("main").getByRole("button", { name: "Log in" }).click();
}

test.describe("the sign-in challenge", () => {
  test("a correct TOTP code completes the sign-in and lands on the redirect target", async ({
    page,
  }) => {
    const account = await signUpFresh(page, "twofachal");
    const { totpURI } = await enableTwoFactor(page, account);
    await signOut(page);

    // Signed out, a protected page bounces to /login with the destination in
    // the query string — the gate's redirect, which must survive the challenge.
    await page.goto("/settings/account");
    await expect(page).toHaveURL(/\/login\?redirect=%2Fsettings%2Faccount/);
    await signInWithPassword(page, account);
    await expect(page).toHaveURL(/\/two-factor/);

    await page.getByLabel("Verification code").fill(await totpFor(totpURI));
    await page.getByRole("button", { name: "Verify" }).click();

    await expect(page).toHaveURL(/\/settings\/account$/);
  });
});

test.describe("passkeys", () => {
  test("registers a passkey and signs in with it", async ({ page }) => {
    // A virtual authenticator stands in for a fingerprint/security key. The
    // passkey plugin requests `userVerification: "required"` at registration
    // (packages/auth/src/index.ts), so the authenticator must be able to
    // prove the person — `isUserVerified: true` is that proof.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("WebAuthn.enable", {});
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
      },
    });

    const account = await signUpFresh(page, "passkey");

    await page.goto("/settings/account");
    await page.getByLabel("Passkey name").fill("E2E key");
    await page.getByRole("button", { name: "Add" }).click();
    await expect(page.getByText("E2E key")).toBeVisible();

    await signOut(page);

    await page.getByRole("button", { name: "Continue with a passkey" }).click();
    await expect(page).toHaveURL(new RegExp(`/@${account.username}$`));
  });
});
