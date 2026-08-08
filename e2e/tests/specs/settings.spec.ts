import { deflateSync } from "node:zlib";
import { expect, test } from "../../support/fixtures";
import { uniqueUser } from "../../support/users";

/**
 * `/settings/account` — the editable profile, the handle, the password and the
 * stored theme/language defaults.
 *
 * Every spec here signs up its own throwaway account rather than reusing
 * alice's storage state, because all of them mutate the account: renaming
 * alice's handle or changing her password would break every other spec in the
 * suite, which reads both from `support/users.ts`.
 */
test.use({ storageState: { cookies: [], origins: [] } });

/**
 * The same all-or-nothing check the stack applies when forwarding `S3_*` to
 * the server (s3Env() in playwright.config.ts): the server refuses to boot on
 * a *partial* group, so with three of four variables set it runs WITHOUT
 * object storage and these upload specs would fail against NOT_IMPLEMENTED.
 * The spec must skip whenever the full group isn't present, not just when
 * the bucket name is.
 */
function storageBucketConfigured(): boolean {
  return ["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"].every((key) =>
    Boolean(process.env[key]),
  );
}

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

  // A fresh sign-up is offered two-factor at /welcome before its profile — see
  // the `signUpAtom` / `useRedirectWhenSignedIn` pairing. Declining is what
  // gets us to the account we came to configure.
  await expect(page).toHaveURL(/\/welcome$/);
  await page.getByRole("button", { name: "Skip for now" }).click();
  await expect(page).toHaveURL(new RegExp(`/@${account.username}$`));

  return account;
}

test.describe("profile details", () => {
  test("saves a display name and bio, and the profile page shows them", async ({ page }) => {
    const account = await signUpFresh(page, "settings");

    await page.goto("/settings/account");
    await page.getByLabel("Display Name").fill("Renamed Person");
    await page.getByLabel("Bio").fill("Collector of small stones.");
    await page.getByRole("button", { name: "Save" }).click();

    await page.goto(`/@${account.username}`);
    await expect(page.getByRole("heading", { name: "Renamed Person" })).toBeVisible();
    await expect(page.getByText("Collector of small stones.")).toBeVisible();
  });

  test("refuses a bio over the limit, and says so rather than failing silently", async ({
    page,
  }) => {
    await signUpFresh(page, "settings");

    await page.goto("/settings/account");
    await page.getByLabel("Bio").fill("x".repeat(161));
    await page.getByRole("button", { name: "Save" }).click();

    // The client's copy and the server's are byte-identical, so this message is
    // the same either way — which is the point of keeping them in step.
    await expect(page.getByRole("alert")).toContainText("160 characters or fewer");
  });
});

/**
 * A real 1x1 PNG. Real bytes matter: the client re-encodes through a canvas
 * (`lib/media.ts`) and the server sniffs the magic bytes of whatever arrives
 * (`packages/api/src/image.ts`), so a fake buffer would be rejected — correctly.
 *
 * Reserved for the specs that only care THAT an image landed. **A 1x1 is not a
 * valid test of the upload path itself**, and this suite learned that the
 * expensive way: every upload spec used one, and a 1x1 is the single size at
 * which a WebP header misparse is invisible — the broken parser reported width
 * 1 for everything, which is exactly what a 1x1 is. A banner bug that rejected
 * every real landscape image as "too large" shipped through a fully green E2E
 * run. The upload specs below use `solidPng` at realistic sizes instead.
 */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/**
 * A genuine PNG of arbitrary size, built here rather than committed as a
 * fixture file so the dimensions that matter are visible at the call site.
 *
 * A gradient rather than a flat colour: a flat image compresses to almost
 * nothing and would not exercise the byte caps at a realistic ratio.
 */
function solidPng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type 2: truecolour RGB

  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const pixel = row + 1 + x * 3;
      raw[pixel] = Math.floor((x * 255) / width);
      raw[pixel + 1] = Math.floor((y * 255) / height);
      raw[pixel + 2] = 0x80;
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * These hit the real Storage Bucket — there is no fake in the browser path.
 * `global-setup.ts` purges the suite's uploaded objects by prefix at the
 * start of every run (via `truncateAll` in support/db.ts), and the whole
 * suite is skipped gracefully on a machine with no `S3_*` group because the
 * procedure reports NOT_IMPLEMENTED rather than crashing.
 */
test.describe("images", () => {
  test.skip(!storageBucketConfigured(), "no Storage Bucket configured (S3_* unset)");

  test("uploads an avatar, and it renders on the profile from /media", async ({ page }) => {
    const account = await signUpFresh(page, "avatar");

    await page.goto("/settings/account");
    // Larger than the 512px avatar box, so the client actually downscales and
    // the server measures a re-encoded WebP rather than a pass-through.
    await page.getByLabel("Profile picture").setInputFiles({
      name: "me.png",
      mimeType: "image/png",
      buffer: solidPng(800, 800),
    });

    // The Remove button only renders once the account actually has an image,
    // so its appearance is the upload landing — not a fixed wait.
    await expect(page.getByRole("button", { name: "Remove Profile picture" })).toBeVisible({
      timeout: 20_000,
    });

    await page.goto(`/@${account.username}`);
    const avatar = page.getByRole("img", { name: account.name }).first();
    await expect(avatar).toHaveAttribute("src", /^\/media\/avatars\//);

    // The stored path is relative and private-bucket-backed, so this proves the
    // whole read path: /media -> presign -> 302 -> bucket.
    const src = await avatar.getAttribute("src");
    const response = await page.request.get(src!);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("image");
  });

  test("uploads a banner into its own slot", async ({ page }) => {
    const account = await signUpFresh(page, "banner");

    await page.goto("/settings/account");
    // A landscape banner, which is the shape a banner actually is — and the
    // shape that regressed. The display object encodes at 1200x400, so its
    // width is well past the slot's 500px HEIGHT bound: a parser that confuses
    // the two axes rejects this as "too large" and passes a square or a 1x1.
    await page.getByLabel("Banner").setInputFiles({
      name: "banner.png",
      mimeType: "image/png",
      buffer: solidPng(1200, 400),
    });
    await expect(page.getByRole("button", { name: "Remove Banner" })).toBeVisible({
      timeout: 20_000,
    });
    // An upload that failed leaves the error banner up; assert it never appeared
    // so a future regression reports the reason rather than a bare timeout.
    await expect(page.getByRole("alert")).toHaveCount(0);

    await page.goto(`/@${account.username}`);
    await expect(page.getByRole("img", { name: /banner/i })).toHaveAttribute(
      "src",
      /^\/media\/banners\//,
    );
  });

  test("removing an image clears it from the profile", async ({ page }) => {
    const account = await signUpFresh(page, "unavatar");

    await page.goto("/settings/account");
    await page.getByLabel("Profile picture").setInputFiles({
      name: "me.png",
      mimeType: "image/png",
      buffer: PNG_1X1,
    });
    const remove = page.getByRole("button", { name: "Remove Profile picture" });
    await expect(remove).toBeVisible({ timeout: 20_000 });

    await remove.click();
    await expect(remove).toBeHidden();

    await page.goto(`/@${account.username}`);
    // Back to the initials fallback — no <img> at all.
    await expect(page.getByRole("img", { name: account.name })).toHaveCount(0);
  });

  test("refuses an SVG, which is a document that can carry script", async ({ page }) => {
    await signUpFresh(page, "svgreject");

    await page.goto("/settings/account");
    await page.getByLabel("Profile picture").setInputFiles({
      name: "sneaky.svg",
      mimeType: "image/svg+xml",
      buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'),
    });

    await expect(page.getByRole("alert")).toContainText("isn't supported");
    await expect(page.getByRole("button", { name: "Remove Profile picture" })).toBeHidden();
  });
});

test.describe("handle", () => {
  test("changing it moves the profile to the new URL and 404s the old one", async ({ page }) => {
    const account = await signUpFresh(page, "rehandle");
    const nextHandle = `${account.username}x`.slice(0, 20);

    await page.goto("/settings/account");
    await page.getByLabel("Username").fill(nextHandle);
    await page.getByRole("button", { name: "Change handle" }).click();

    await expect(page).toHaveURL(new RegExp(`/@${nextHandle}$`));

    // The warning on that form is literal: the old address stops existing, and
    // nothing redirects from it.
    await page.goto(`/@${account.username}`);
    await expect(page.getByText("This handle isn't taken")).toBeVisible();
  });

  test("refuses a handle that is already taken", async ({ page, db }) => {
    const taken = uniqueUser("taken");
    await db.createUser(taken);
    await signUpFresh(page, "clash");

    await page.goto("/settings/account");
    await page.getByLabel("Username").fill(taken.username);
    await page.getByRole("button", { name: "Change handle" }).click();

    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page).toHaveURL(/\/settings\/account$/);
  });
});

test.describe("password", () => {
  test("changes the password, and the new one signs in", async ({ page }) => {
    const account = await signUpFresh(page, "pwchange");
    const newPassword = "correct-horse-battery-99";

    await page.goto("/settings/account");
    await page.getByLabel("Current Password").fill(account.password);
    await page.getByLabel("New Password", { exact: true }).fill(newPassword);
    await page.getByLabel("Confirm New Password").fill(newPassword);
    await page.getByRole("button", { name: "Change password" }).click();

    await expect(page.getByText("Your password has been changed.")).toBeVisible();

    await page.goto("/settings/account");
    await page.getByRole("button", { name: "Sign out" }).first().click();
    await expect(page).toHaveURL(/\/login/);

    await page.getByLabel("Username or Email").fill(account.email);
    await page.getByLabel("Password").fill(newPassword);
    await page.getByRole("main").getByRole("button", { name: "Log in" }).click();

    await expect(page).toHaveURL(new RegExp(`/@${account.username}$`));
  });

  test("rejects a wrong current password", async ({ page }) => {
    await signUpFresh(page, "pwwrong");

    await page.goto("/settings/account");
    await page.getByLabel("Current Password").fill("definitely-not-it");
    await page.getByLabel("New Password", { exact: true }).fill("correct-horse-battery-98");
    await page.getByLabel("Confirm New Password").fill("correct-horse-battery-98");
    await page.getByRole("button", { name: "Change password" }).click();

    await expect(page.getByRole("alert")).toBeVisible();
  });
});

test.describe("preferences", () => {
  test("stores a default theme without changing this device's current one", async ({ page }) => {
    await signUpFresh(page, "prefs");

    await page.goto("/settings/account");
    await page
      .getByRole("group", { name: "Default theme" })
      .getByRole("button", { name: "Dark" })
      .click();

    // Pressed state comes from the *account*, not from this device — the two
    // are separate by design.
    await expect(
      page.getByRole("group", { name: "Default theme" }).getByRole("button", { name: "Dark" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  test("the stored default applies in a browser that has never chosen", async ({
    browser,
    page,
  }) => {
    const account = await signUpFresh(page, "prefsfresh");

    await page.goto("/settings/account");
    await page
      .getByRole("group", { name: "Default theme" })
      .getByRole("button", { name: "Dark" })
      .click();
    await expect(
      page.getByRole("group", { name: "Default theme" }).getByRole("button", { name: "Dark" }),
    ).toHaveAttribute("aria-pressed", "true");

    // A genuinely fresh context: no localStorage, no cookie — the state the
    // account default exists to fill.
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const fresh = await context.newPage();
    await fresh.goto("/login");
    await fresh.getByLabel("Username or Email").fill(account.email);
    await fresh.getByLabel("Password").fill(account.password);
    await fresh.getByRole("main").getByRole("button", { name: "Log in" }).click();
    await expect(fresh).toHaveURL(new RegExp(`/@${account.username}$`));

    await expect(fresh.locator("html")).toHaveClass(/dark/);
    await context.close();
  });
});

test.describe("the two-factor offer", () => {
  test("is shown once after sign-up and can be skipped", async ({ page }) => {
    // `signUpFresh` already asserts the offer appears and skips it; this pins
    // the other half — that it does not come back.
    const account = await signUpFresh(page, "twofaskip");

    await page.goto("/");
    await expect(page).toHaveURL(/\/$/);

    await page.goto("/welcome");
    // Nothing outstanding, so the page has no business rendering: the redirect
    // effect sends them to their profile instead of re-offering.
    await expect(page).toHaveURL(new RegExp(`/@${account.username}$`));
  });
});
