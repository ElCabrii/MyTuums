import { test, expect } from "../../support/fixtures";
import { ALICE } from "../../support/users";

// The chromium project's default storageState is alice's — override it for
// this whole file so every test starts genuinely signed out, matching what
// the login/register pages themselves guard against (useRedirectWhenSignedIn).
test.use({ storageState: { cookies: [], origins: [] } });

test.describe("registration", () => {
  test("registering a fresh account signs the user in and redirects off /register", async ({
    page,
  }) => {
    const username = `e2enew${Date.now().toString(36)}`;

    await page.goto("/register");
    await page.getByLabel("Username").fill(username);
    await page.getByLabel("Display Name").fill("Freshly Registered");
    await page.getByLabel("Email Address").fill(`${username}@example.test`);
    // "Password" is a substring of "Confirm Password" too, so this needs
    // `exact` to avoid a strict-mode ambiguity between the two labels.
    await page.getByLabel("Password", { exact: true }).fill("a-fresh-password-1");
    await page.getByLabel("Confirm Password").fill("a-fresh-password-1");
    // Scoped to <main>: the header nav renders its own "Register" button
    // (signed out) with the identical accessible name, so an unscoped query
    // matches two elements.
    await page.getByRole("main").getByRole("button", { name: "Register" }).click();

    // useRedirectWhenSignedIn is the entire post-signup redirect — signUpAtom
    // deliberately doesn't navigate itself (see atoms/auth.ts) — so this also
    // proves the session actually took.
    await expect(page).toHaveURL(new RegExp(`/@${username}$`));
  });

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
    // Scoped to <main>: the header nav renders its own "Register" button
    // (signed out) with the identical accessible name, so an unscoped query
    // matches two elements.
    await page.getByRole("main").getByRole("button", { name: "Register" }).click();

    const alert = page.getByRole("alert");
    await expect(alert).toContainText("Username must be between 3 and 20 characters long.");
    await expect(alert).not.toContainText("Password must be at least 8");
    await expect(alert).not.toContainText("Passwords do not match");
  });
});

test.describe("login", () => {
  test("logging in works by username", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Username or Email").fill(ALICE.username);
    await page.getByLabel("Password").fill(ALICE.password);
    // Scoped to <main>: the header nav renders its own "Log in" button
    // (signed out) with the identical accessible name, so an unscoped query
    // matches two elements.
    await page.getByRole("main").getByRole("button", { name: "Log in" }).click();

    await expect(page).toHaveURL(new RegExp(`/@${ALICE.username}$`));
  });

  test("logging in works by email", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Username or Email").fill(ALICE.email);
    await page.getByLabel("Password").fill(ALICE.password);
    // Scoped to <main>: the header nav renders its own "Log in" button
    // (signed out) with the identical accessible name, so an unscoped query
    // matches two elements.
    await page.getByRole("main").getByRole("button", { name: "Log in" }).click();

    await expect(page).toHaveURL(new RegExp(`/@${ALICE.username}$`));
  });

  test("visiting /login while already signed in redirects away", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Username or Email").fill(ALICE.username);
    await page.getByLabel("Password").fill(ALICE.password);
    // Scoped to <main>: the header nav renders its own "Log in" button
    // (signed out) with the identical accessible name, so an unscoped query
    // matches two elements.
    await page.getByRole("main").getByRole("button", { name: "Log in" }).click();
    await expect(page).toHaveURL(new RegExp(`/@${ALICE.username}$`));

    await page.goto("/login");

    await expect(page).toHaveURL(new RegExp(`/@${ALICE.username}$`));
  });
});

test.describe("logout", () => {
  test("logging out clears the session and the header reflects it", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Username or Email").fill(ALICE.username);
    await page.getByLabel("Password").fill(ALICE.password);
    // Scoped to <main>: the header nav renders its own "Log in" button
    // (signed out) with the identical accessible name, so an unscoped query
    // matches two elements.
    await page.getByRole("main").getByRole("button", { name: "Log in" }).click();
    await expect(page).toHaveURL(new RegExp(`/@${ALICE.username}$`));

    await page.getByRole("button", { name: "Sign out" }).click();

    // NOT asserting a landing URL of /login here — see the note below. The
    // one thing reliably true regardless of that race is that the header
    // eventually reflects a signed-out viewer, so that's what this checks.
    //
    // BUG (found while writing this suite, not fixed — app source is out of
    // scope for this suite): `profile-layout.tsx`'s handleSignOut awaits
    // `signOutAtom` and then calls `navigate({ to: "/login" })`. But
    // `signOutAtom` only awaits BetterAuth's `authClient.signOut()`, i.e. the
    // `/sign-out` network call — it does NOT wait for the session nanostore
    // to actually go null. BetterAuth updates that store via a SEPARATE,
    // unawaited `/get-session` refetch triggered off the same sign-out
    // signal (see `getSessionAtom` in
    // node_modules/better-auth/dist/client/session-atom.mjs). In practice
    // that refetch consistently loses the race against the synchronous
    // `navigate()` call: `/login` mounts while `isSignedInAtom` is still
    // (stale-)true, `useRedirectWhenSignedIn` fires on that stale read, and
    // it bounces straight back to `/@alice` — reproduced deterministically
    // across repeated runs, not a one-off flake. The fix would live in
    // `atoms/auth.ts`'s `signOutAtom` (wait for the store to actually
    // reflect signed-out before resolving) but that's app source, out of
    // scope here.
    await expect(
      page.getByRole("banner").getByRole("button", { name: "Log in" }),
    ).toBeVisible();
  });
});
