import { test, expect } from "../../support/fixtures";
import { ALICE, dateOfBirthUnder15 } from "../../support/users";

// The chromium project's default storageState is alice's — override it for
// this whole file so every test starts genuinely signed out, matching what
// the login/register pages themselves guard against (useRedirectWhenSignedIn).
test.use({ storageState: { cookies: [], origins: [] } });

test.describe("registration", () => {
  test("validation errors surface in submit-handler order when several rules are violated", async ({
    page,
  }) => {
    await page.goto("/register");

    // Every field is non-empty (native `required` would otherwise block
    // submission before our own handler ever runs, and this needs the
    // handler to run). Three rules are violated at once — username too
    // short, password too short, and passwords mismatched — to prove only
    // the FIRST one (validateRegister in lib/auth-validation.ts checks
    // username length before it ever looks at the password fields) reaches
    // the alert.
    await page.getByLabel("Username").fill("ab");
    await page.getByLabel("Display Name").fill("Someone");
    await page.getByLabel("Email Address").fill("someone@example.test");
    await page.getByLabel("Password", { exact: true }).fill("123");
    await page.getByLabel("Confirm Password").fill("456");
    // A valid date of birth keeps native `required` from blocking submission
    // — the point of this test is the ordering of the *handler's* rules.
    await page.getByLabel("Date of Birth").fill("1995-01-01");
    await page.getByRole("main").getByRole("button", { name: "Register" }).click();

    const alert = page.getByRole("alert");
    await expect(alert).toContainText("Username must be between 3 and 20 characters long.");
    await expect(alert).not.toContainText("Password must be at least 8");
    await expect(alert).not.toContainText("Passwords do not match");
  });

  test("an under-15 date of birth is rejected with the age rule and no account is created", async ({
    page,
  }) => {
    const username = `e2eminor${Date.now().toString(36)}`;

    await page.goto("/register");
    await page.getByLabel("Username").fill(username);
    await page.getByLabel("Display Name").fill("Minor Fixture");
    await page.getByLabel("Email Address").fill(`${username}@example.test`);
    await page.getByLabel("Password", { exact: true }).fill("a-fresh-password-1");
    await page.getByLabel("Confirm Password").fill("a-fresh-password-1");
    await page.getByLabel("Date of Birth").fill(dateOfBirthUnder15());
    await page.getByRole("main").getByRole("button", { name: "Register" }).click();

    await expect(page.getByRole("alert")).toContainText(
      "You must be at least 15 years old to create an account.",
    );
    await expect(page).toHaveURL(/\/register$/);
  });
});

test.describe("login", () => {
  test("logging in works by username", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Username or Email").fill(ALICE.username);
    await page.getByLabel("Password").fill(ALICE.password);
    await page.getByRole("main").getByRole("button", { name: "Log in" }).click();

    await expect(page).toHaveURL(new RegExp(`/@${ALICE.username}$`));
  });
});

test.describe("logout", () => {
  test("logging out clears the session and removes the header", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Username or Email").fill(ALICE.username);
    await page.getByLabel("Password").fill(ALICE.password);
    await page.getByRole("main").getByRole("button", { name: "Log in" }).click();
    await expect(page).toHaveURL(new RegExp(`/@${ALICE.username}$`));

    await page.getByRole("button", { name: "Sign out" }).click();

    // This URL assertion is the regression test for a race that used to make
    // it impossible.
    //
    // `signOutAtom` awaited only BetterAuth's `/sign-out` call, which does NOT
    // wait for the session nanostore to empty — BetterAuth refreshes that
    // through a separate, unawaited `/get-session` (see `getSessionAtom` in
    // better-auth's client/session-atom.mjs). That refetch reliably lost the
    // race against the `navigate({ to: "/login" })` right after it, so /login
    // mounted while `isSignedInAtom` was still stale-true,
    // `useRedirectWhenSignedIn` read the stale value, and bounced straight
    // back to /@alice. It reproduced deterministically, so this spec used to
    // assert only the header.
    //
    // `signOutAtom` now awaits `waitForSignedOut()` (apps/web/src/lib/
    // session-sync.ts) before resolving. If that await is ever removed, this
    // line fails rather than the behaviour silently regressing.
    //
    // The trailing `(?redirect=...)?` is the signed-in gate (use-require-
    // signed-in.ts) racing the app's own navigate: both end up at /login, but
    // the gate preserves the profile URL it was standing on — which is the
    // intended behaviour, not a bug.
    await expect(page).toHaveURL(/\/login(\?redirect=.*)?$/);

    // The header only renders for a real session (see __root.tsx), so after
    // sign-out there is no banner at all — not merely no sign-in buttons in
    // one. `toBeHidden` also passes when the element does not exist.
    await expect(page.getByRole("banner")).toBeHidden();
  });
});

test.describe("signed-in gate", () => {
  test("sends a signed-out visitor to /login with the destination, and back after signing in", async ({
    page,
  }) => {
    await page.goto("/discover");

    // The gate preserves where the visitor was headed, so the trip there
    // survives the sign-in.
    await expect(page).toHaveURL(/\/login\?redirect=/);

    await page.getByLabel("Username or Email").fill(ALICE.username);
    await page.getByLabel("Password").fill(ALICE.password);
    await page.getByRole("main").getByRole("button", { name: "Log in" }).click();

    await expect(page).toHaveURL(/\/discover$/);
  });

  test("a deep profile link survives the round trip too", async ({ page }) => {
    await page.goto("/@alice");

    await expect(page).toHaveURL(/\/login\?redirect=/);

    await page.getByLabel("Username or Email").fill(ALICE.username);
    await page.getByLabel("Password").fill(ALICE.password);
    await page.getByRole("main").getByRole("button", { name: "Log in" }).click();

    await expect(page).toHaveURL(/\/@alice$/);
  });

  test("leaves the legal pages readable while signed out", async ({ page }) => {
    await page.goto("/privacy");
    await expect(page).toHaveURL(/\/privacy$/);

    await page.goto("/terms");
    await expect(page).toHaveURL(/\/terms$/);
  });
});

test.describe("cold load", () => {
  test("the splash is on screen while the first session fetch is pending", async ({ page }) => {
    // Hold the first /get-session open so the pending window is long enough
    // to assert into. The splash is static markup in index.html — it must be
    // on screen from the first paint, before the bundle even mounts. (That it
    // is REMOVED once the session settles needs no dedicated test: every spec
    // in this suite interacts with the app past the splash, and the removal
    // logic itself is pinned by the sessionSettledAtom unit tests.)
    await page.route("**/api/auth/get-session*", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await route.continue();
    });
    await page.goto("/");

    await expect(page.getByRole("status")).toBeVisible();
  });
});
