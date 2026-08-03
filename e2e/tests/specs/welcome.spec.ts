import { expect, test } from "../../support/fixtures";
import { dateOfBirthUnder15, uniqueUser } from "../../support/users";

/**
 * The `/welcome` completion gate — the handle and the date of birth.
 *
 * A social sign-up produces a signed-in session with `user.username` null —
 * the `username` plugin does not populate it and has no auto-generation
 * option. This app keys every profile URL, follow list and `user.byUsername`
 * lookup on that column, so such a session has no profile page, cannot be
 * followed, and used to fall through `header.tsx`'s `user && handle` branch
 * into rendering "Log in"/"Register" to someone already signed in.
 *
 * And since the 15+ rule landed, any account without a declared date of
 * birth — a social sign-up, or one that predates the rule — is held here
 * too, until it declares one (`needsCompletionAtom` in atoms/session.ts).
 *
 * These specs drive that state directly (`db.clearUsername` /
 * `db.clearDateOfBirth`) rather than through a real OAuth round trip, which
 * would need Google's consent screen and live credentials. What is being
 * guarded is the null column, not the provider that produced it.
 */
test.use({ storageState: { cookies: [], origins: [] } });

/** Signs up, strips the handle, and signs back in by email — email works without one. */
async function signedInWithoutHandle(
  page: import("@playwright/test").Page,
  db: typeof import("../../support/db"),
) {
  const account = uniqueUser("handleless");
  const created = await db.createUser(account);
  await db.clearUsername(created.id);

  await page.goto("/login");
  await page.getByLabel("Username or Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("main").getByRole("button", { name: "Log in" }).click();

  return account;
}

/** Signs up, strips the date of birth, and signs back in — the pre-rule-account state. */
async function signedInWithoutDob(
  page: import("@playwright/test").Page,
  db: typeof import("../../support/db"),
) {
  const account = uniqueUser("undob");
  const created = await db.createUser(account);
  await db.clearDateOfBirth(created.id);

  await page.goto("/login");
  await page.getByLabel("Username or Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("main").getByRole("button", { name: "Log in" }).click();

  return account;
}

test.describe("handle gate", () => {
  test("sends a signed-in session with no handle to /welcome instead of a profile", async ({
    page,
    db,
  }) => {
    await signedInWithoutHandle(page, db);

    await expect(page).toHaveURL(/\/welcome$/);
    await expect(page.getByRole("heading", { name: "Pick your handle" })).toBeVisible();
  });

  test("keeps them there when they try to navigate away", async ({ page, db }) => {
    await signedInWithoutHandle(page, db);
    await expect(page).toHaveURL(/\/welcome$/);

    // The gate is mounted in __root.tsx rather than per-route, so this holds
    // for any destination, not just the ones that remembered to check.
    await page.goto("/discover");
    await expect(page).toHaveURL(/\/welcome$/);
  });

  test("shows the account as signed in, not as a visitor", async ({ page, db }) => {
    await signedInWithoutHandle(page, db);
    await expect(page).toHaveURL(/\/welcome$/);

    // The regression this guards: the header used to branch on `user && handle`
    // and render sign-in buttons to a signed-in person with no handle yet.
    await expect(
      page.getByRole("banner").getByRole("button", { name: "Log in" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("banner").getByRole("button", { name: "Register" }),
    ).toHaveCount(0);
  });

  test("still lets them read the legal pages — a gate that hides the terms is its own problem", async ({
    page,
    db,
  }) => {
    await signedInWithoutHandle(page, db);
    await expect(page).toHaveURL(/\/welcome$/);

    await page.goto("/terms");
    await expect(page).toHaveURL(/\/terms$/);
  });

  test("claiming a handle releases the gate and lands on the new profile", async ({ page, db }) => {
    await signedInWithoutHandle(page, db);
    await expect(page).toHaveURL(/\/welcome$/);

    const handle = `claimed${Date.now().toString(36)}`.slice(0, 20);
    await page.getByLabel("Username").fill(handle);
    await page.getByRole("button", { name: "Claim handle" }).click();

    // The navigation only survives because `claimWelcomeFieldsAtom` waits for
    // the session store to actually carry the new handle first — otherwise
    // `useRequireHandle` reads a still-null username and bounces straight back.
    await expect(page).toHaveURL(new RegExp(`/@${handle}$`));

    await page.goto("/");
    await expect(page).toHaveURL(/\/$/);
  });

  test("rejects a handle that is already taken", async ({ page, db }) => {
    const taken = uniqueUser("taken");
    await db.createUser(taken);

    await signedInWithoutHandle(page, db);
    await expect(page).toHaveURL(/\/welcome$/);

    await page.getByLabel("Username").fill(taken.username);
    await page.getByRole("button", { name: "Claim handle" }).click();

    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page).toHaveURL(/\/welcome$/);
  });

  test("rejects a handle that breaks the character rules, before any request", async ({
    page,
    db,
  }) => {
    await signedInWithoutHandle(page, db);
    await expect(page).toHaveURL(/\/welcome$/);

    await page.getByLabel("Username").fill("no spaces");
    await page.getByRole("button", { name: "Claim handle" }).click();

    await expect(page.getByRole("alert")).toContainText(
      "letters, numbers, underscores, and hyphens",
    );
  });
});

test.describe("date of birth gate", () => {
  test("sends a signed-in session with no date of birth to /welcome", async ({ page, db }) => {
    await signedInWithoutDob(page, db);

    await expect(page).toHaveURL(/\/welcome$/);
    await expect(page.getByRole("heading", { name: "One more step" })).toBeVisible();
  });

  test("keeps them there when they try to navigate away", async ({ page, db }) => {
    await signedInWithoutDob(page, db);
    await expect(page).toHaveURL(/\/welcome$/);

    await page.goto("/discover");
    await expect(page).toHaveURL(/\/welcome$/);
  });

  test("an account that already has its handle is not asked for another one", async ({
    page,
    db,
  }) => {
    await signedInWithoutDob(page, db);
    await expect(page).toHaveURL(/\/welcome$/);

    await expect(page.getByLabel("Username")).toHaveCount(0);
    await expect(page.getByLabel("Date of Birth")).toBeVisible();
  });

  test("claiming a date of birth releases the gate and lands on the profile", async ({
    page,
    db,
  }) => {
    const account = await signedInWithoutDob(page, db);
    await expect(page).toHaveURL(/\/welcome$/);

    await page.getByLabel("Date of Birth").fill("1995-01-01");
    await page.getByRole("button", { name: "Save" }).click();

    await expect(page).toHaveURL(new RegExp(`/@${account.username}$`));
  });

  test("an under-15 date of birth shows the alert and stays on /welcome", async ({ page, db }) => {
    await signedInWithoutDob(page, db);
    await expect(page).toHaveURL(/\/welcome$/);

    await page.getByLabel("Date of Birth").fill(dateOfBirthUnder15());
    await page.getByRole("button", { name: "Save" }).click();

    await expect(page.getByRole("alert")).toContainText(
      "You must be at least 15 years old to create an account.",
    );
    await expect(page).toHaveURL(/\/welcome$/);
  });
});

test.describe("welcome route guards", () => {
  test("redirects a signed-out visitor to /login", async ({ page }) => {
    await page.goto("/welcome");
    await expect(page).toHaveURL(/\/login$/);
  });
});
