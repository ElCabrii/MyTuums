import { base32 } from "@better-auth/utils/base32";
import { createOTP } from "@better-auth/utils/otp";
import { expect, test } from "../../support/fixtures";
import { uniqueUser } from "../../support/users";

/**
 * The two-factor surface, end to end: enrolment through the settings UI, the
 * `/two-factor` challenge after a real sign-in, backup codes, the emailed
 * code, and a passkey registered and used through the real WebAuthn ceremony.
 *
 * Every spec signs up its own throwaway account (same reason as
 * settings.spec.ts): enabling 2FA on alice would break every other spec's
 * storage state, and a mid-run failure would leave her locked behind a
 * challenge nobody can answer.
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
  await page.getByRole("main").getByRole("button", { name: "Register" }).click();

  // A fresh sign-up is offered two-factor at /welcome before its profile —
  // see the `signUpAtom` / `useRedirectWhenSignedIn` pairing. Declining is
  // what gets us to the account we came to configure.
  await expect(page).toHaveURL(/\/welcome$/);
  await page.getByRole("button", { name: "Skip for now" }).click();
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
 * Enables two-factor through the settings UI and returns what the server
 * handed the browser: the TOTP URI (captured from the enable response, the
 * same bytes the QR code renders) and the ten backup codes.
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
  const body = (await (await enableResponse).json()) as {
    totpURI?: string;
    backupCodes?: string[];
  };
  if (!body.totpURI) throw new Error("two-factor enable response carried no TOTP URI");

  await page.getByLabel("Verification code").fill(await totpFor(body.totpURI));
  await page.getByRole("button", { name: "Confirm" }).click();

  // The section flips to the on-state once the session reports the flag.
  await expect(page.getByText("On. You'll be asked for a code when you sign in.")).toBeVisible();

  return { totpURI: body.totpURI, backupCodes: body.backupCodes ?? [] };
}

/** Signs out from the settings page and lands on /login. */
async function signOut(page: import("@playwright/test").Page) {
  await page.goto("/settings/account");
  await page.getByRole("button", { name: "Sign out" }).first().click();
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

test.describe("enrolment", () => {
  test("enables two-factor through the UI and the section reports it on", async ({ page }) => {
    const account = await signUpFresh(page, "twofaon");
    const { backupCodes } = await enableTwoFactor(page, account);

    expect(backupCodes.length).toBeGreaterThan(0);
    await expect(page.getByRole("button", { name: "Turn off" })).toBeVisible();
  });
});

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

  test("a wrong code shows the error and stays on the challenge", async ({ page }) => {
    const account = await signUpFresh(page, "twofawrong");
    await enableTwoFactor(page, account);
    await signOut(page);

    await page.goto("/login");
    await signInWithPassword(page, account);
    await expect(page).toHaveURL(/\/two-factor/);

    await page.getByLabel("Verification code").fill("000000");
    await page.getByRole("button", { name: "Verify" }).click();

    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page).toHaveURL(/\/two-factor/);
  });

  test("a backup code works once and never again", async ({ page }) => {
    const account = await signUpFresh(page, "twofabackup");
    const { backupCodes } = await enableTwoFactor(page, account);
    const [code] = backupCodes;
    await signOut(page);

    await page.goto("/login");
    await signInWithPassword(page, account);
    await expect(page).toHaveURL(/\/two-factor/);
    await page.getByRole("button", { name: "Use a backup code" }).click();
    await page.getByLabel("Backup code").fill(code);
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page).toHaveURL(new RegExp(`/@${account.username}$`));

    // A backup code that can be replayed is just a password that never
    // expires — the second use of the same code must fail.
    await signOut(page);
    await page.goto("/login");
    await signInWithPassword(page, account);
    await expect(page).toHaveURL(/\/two-factor/);
    await page.getByRole("button", { name: "Use a backup code" }).click();
    await page.getByLabel("Backup code").fill(code);
    await page.getByRole("button", { name: "Verify" }).click();

    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page).toHaveURL(/\/two-factor/);
  });

  test("an emailed code completes the sign-in", async ({ page, db }) => {
    const account = await signUpFresh(page, "twofaotp");
    await enableTwoFactor(page, account);
    await signOut(page);

    await page.goto("/login");
    await signInWithPassword(page, account);
    await expect(page).toHaveURL(/\/two-factor/);

    const otpResponse = page.waitForResponse(
      (response) =>
        response.url().includes("/api/auth/two-factor/send-otp") &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Email me a code instead" }).click();
    await otpResponse;

    // The E2E stack has no mailbox (RESEND_API_KEY is blanked), so the code
    // is read from the verification table — the same place the plugin wrote
    // it before the response above landed. The row is keyed on the signed
    // challenge cookie, which is the challenge's only identity (no session
    // exists mid-challenge), so the cookie is what the lookup needs.
    const challengeCookie = (await page.context().cookies()).find(
      (cookie) => cookie.name === "better-auth.two_factor",
    );
    if (!challengeCookie) throw new Error("no two-factor challenge cookie after sign-in");
    // The cookie value is URL-encoded on the wire (`+` and `=` become %2B and
    // %3D), and the verification row's identifier is keyed on the *unsigned*
    // payload — the part before the `.` signature — which is what
    // `getSignedCookie` hands the plugin. The payload charset (a-z0-9A-Z_-)
    // contains no `.`, so splitting on the first dot is the same as the
    // server's split on the last.
    const challengeKey = decodeURIComponent(challengeCookie.value).split(".")[0];
    const otp = await db.twoFactorOtpFor(challengeKey);
    await page.getByLabel("Verification code").fill(otp);
    await page.getByRole("button", { name: "Verify" }).click();

    await expect(page).toHaveURL(new RegExp(`/@${account.username}$`));
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
