import { expect, test } from "../../support/fixtures";
import type { Locator } from "@playwright/test";
import { emailVerificationLinkFor } from "../../support/db";
import { solidPng } from "../../support/image";
import { E2E } from "../../playwright.config";
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

/**
 * The uploaded object must be the canonical 3:1, and its display frame must be
 * the 3:1 composition with the height clamps from `apps/web/src/lib/banner-frame.ts`.
 *
 * The natural-image ratio is pinned exactly (3, 5): the encoded variant is
 * always 3:1. The frame is *clamped*, not 3:1 at every width — exact 3:1 only
 * where neither clamp binds (roughly 450–960px wide); a narrow phone holds a
 * 150px band (X's mobile-header height) and trims the image's sides, and past
 * the 1500px measure the frame stops at 320px tall and trims top and bottom.
 *
 * The clamps are pinned by absolute sizes, and their *direction* by
 * inequality, never by a pinned frame ratio at a clamped width: a classic
 * scrollbar takes ~15px off the viewport, so the frame's exact ratio there
 * (2.5 vs 2.6 at a 390px viewport) depends on browser chrome the spec must
 * not depend on. Heights and the 1500px measure are chrome-independent.
 */
async function bannerFrameBounds(banner: Locator): Promise<{ width: number; height: number }> {
  await expect(banner).toBeVisible();
  await expect
    .poll(() =>
      banner.evaluate((image: HTMLImageElement) =>
        image.naturalHeight === 0 ? 0 : image.naturalWidth / image.naturalHeight,
      ),
    )
    .toBeCloseTo(3, 5);

  return banner.evaluate((image) => {
    const frame = image.parentElement;
    if (!frame) throw new Error("banner image has no display frame");
    const bounds = frame.getBoundingClientRect();
    return { width: bounds.width, height: bounds.height };
  });
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
  await page.getByRole("checkbox", { name: /I have read and agree/ }).check();
  await page.getByRole("main").getByRole("button", { name: "Register" }).click();

  // requireEmailVerification (packages/auth): sign-up creates the account and
  // sends the verification link but issues NO session, so the person lands on
  // /verify-email rather than /welcome (issue #172). The post-signup two-factor
  // offer is gone on the password path — a documented tradeoff; 2FA stays
  // configurable from settings, which is what these specs exercise anyway.
  await expect(page).toHaveURL(/\/verify-email$/);

  // Complete verification by visiting the link a real email would carry:
  // `autoSignInAfterVerification` mints the session and `useRedirectWhenSignedIn`
  // lands the now-complete account on its profile — the state every test below
  // starts from.
  await page.goto(emailVerificationLinkFor(account.email, `${E2E.webUrl}/verify-email`));
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
});

/**
 * These hit the real Storage Bucket — there is no fake in the browser path.
 * `global-setup.ts` purges the suite's uploaded objects by prefix at the
 * start of every run (via `truncateAll` in support/db.ts), and the whole
 * suite is skipped gracefully on a machine with no `S3_*` group because the
 * procedure reports NOT_IMPLEMENTED rather than crashing.
 */
test.describe("images", () => {
  test.skip(!storageBucketConfigured(), "no Storage Bucket configured (S3_* unset)");

  /**
   * Picking a file opens the crop editor (issue #151) instead of uploading
   * straight away; the upload only starts once a crop is committed. Applying
   * the default (centered, unzoomed) crop is what these specs want — they are
   * about the upload path, not about the editor, which has its own component
   * suite in apps/web.
   */
  async function applyCrop(page: import("@playwright/test").Page) {
    const apply = page.getByRole("button", { name: "Apply" });
    await expect(apply).toBeEnabled();
    await apply.click();
  }

  test("uploads an avatar, renders it on the profile from /media, and clears it again", async ({
    page,
  }) => {
    const account = await signUpFresh(page, "avatar");

    await page.goto("/settings/account");
    // Larger than the 512px avatar box, so the client actually downscales and
    // the server measures a re-encoded WebP rather than a pass-through.
    await page.getByLabel("Profile picture").setInputFiles({
      name: "me.png",
      mimeType: "image/png",
      buffer: solidPng(800, 800),
    });
    await applyCrop(page);

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

    // Removal shares this account rather than paying for a second sign-up: it
    // is the same lifecycle, and the profile falling back to initials is the
    // only browser-visible half `profile-media.int.test.ts` cannot assert.
    await page.goto("/settings/account");
    const remove = page.getByRole("button", { name: "Remove Profile picture" });
    await remove.click();
    await expect(remove).toBeHidden();

    await page.goto(`/@${account.username}`);
    await expect(page.getByRole("img", { name: account.name })).toHaveCount(0);
  });

  test("keeps one banner composition in Settings and across profile widths", async ({ page }) => {
    const account = await signUpFresh(page, "banner");

    await page.goto("/settings/account");
    // A landscape banner, which is the shape a banner actually is — and the
    // shape that regressed. The display object encodes at 1500x500, so swapping
    // its axes produces a 500x1500 image beyond the 1280px height bound. A
    // square or smaller landscape fixture would let that parser bug pass.
    await page.getByLabel("Banner").setInputFiles({
      name: "banner.png",
      mimeType: "image/png",
      buffer: solidPng(1500, 500),
    });
    await applyCrop(page);
    await expect(page.getByRole("button", { name: "Remove Banner" })).toBeVisible({
      timeout: 20_000,
    });
    // An upload that failed leaves the error banner up; assert it never appeared
    // so a future regression reports the reason rather than a bare timeout.
    await expect(page.getByRole("alert")).toHaveCount(0);

    // The Settings preview is the plain canonical composition: w-28 at exactly
    // 3:1, no clamps.
    const preview = await bannerFrameBounds(page.getByRole("img", { name: "Banner" }));
    expect(preview.width / preview.height).toBeCloseTo(3, 2);

    await page.goto(`/@${account.username}`);
    const profileBanner = page.getByRole("img", { name: /banner/i });
    await expect(profileBanner).toHaveAttribute("src", /^\/media\/banners\//);

    // The clamped profile frame, one viewport per regime (see the helper's
    // comment for why the clamped widths assert sizes and inequalities).
    await page.setViewportSize({ width: 390, height: 900 });
    const phone = await bannerFrameBounds(profileBanner);
    expect(phone.height).toBeCloseTo(150, 1); // the phone band, not a 125px 3:1 sliver
    expect(phone.width / phone.height).toBeLessThan(3);

    await page.setViewportSize({ width: 768, height: 900 });
    const tablet = await bannerFrameBounds(profileBanner);
    expect(tablet.width / tablet.height).toBeCloseTo(3, 2); // unclamped: the whole composition

    await page.setViewportSize({ width: 1440, height: 900 });
    const laptop = await bannerFrameBounds(profileBanner);
    expect(laptop.height).toBeCloseTo(320, 1); // the height cap, not a 480px slab
    expect(laptop.width / laptop.height).toBeGreaterThan(3);

    // 2560 is wide enough that the 1500px measure binds too. Pinning width AND
    // height is what catches the measure or a clamp regressing into the old
    // unbounded slab (issue #240); a loose ratio alone cannot.
    await page.setViewportSize({ width: 2560, height: 900 });
    const wide = await bannerFrameBounds(profileBanner);
    expect(wide.width).toBeCloseTo(1500, 1);
    expect(wide.height).toBeCloseTo(320, 1);
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
});

test.describe("password", () => {
  test("changes the password, and the new one signs in", async ({ page }) => {
    const account = await signUpFresh(page, "pwchange");
    const replacementPassphrase = "correct-horse-battery-99";

    await page.goto("/settings/account");
    await page.getByLabel("Current Password").fill(account.password);
    await page.getByLabel("New Password", { exact: true }).fill(replacementPassphrase);
    await page.getByLabel("Confirm New Password").fill(replacementPassphrase);
    await page.getByRole("button", { name: "Change password" }).click();

    await expect(page.getByText("Your password has been changed.")).toBeVisible();

    // Sign out from the section this page now carries again (issue #282
    // partially reverts #217) — no detour through the profile action row,
    // which no longer has a button.
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login/);

    await page.getByLabel("Username or Email").fill(account.email);
    await page.getByLabel("Password").fill(replacementPassphrase);
    await page.getByRole("main").getByRole("button", { name: "Log in" }).click();

    await expect(page).toHaveURL(new RegExp(`/@${account.username}$`));
  });
});

test.describe("preferences", () => {});
