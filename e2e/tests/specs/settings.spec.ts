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
 * The uploaded object and its immediate display frame must share the canonical
 * 3:1 aspect. Equal aspects make `object-cover` a no-op: every marker in an
 * asymmetric source remains in the composition instead of being silently
 * removed by a viewport-dependent second crop (issue #234).
 *
 * Aspect and bounded height are two different properties, and both are
 * asserted: a 1440x480 frame and a 1500x500 frame are both exactly 3:1, and so
 * was the unbounded full-bleed frame that rendered 853px tall at 2560px
 * viewports (issue #240). `expectedHeight` catches that where the 1500px
 * measure binds — on viewports wider than the cap, where the height has a
 * single exact value; below the cap the height is viewportWidth / 3 and no
 * number is worth pinning.
 */
async function expectCanonicalBannerGeometry(banner: Locator, expectedHeight?: number) {
  await expect(banner).toBeVisible();
  await expect
    .poll(() =>
      banner.evaluate((image: HTMLImageElement) =>
        image.naturalHeight === 0 ? 0 : image.naturalWidth / image.naturalHeight,
      ),
    )
    .toBeCloseTo(3, 5);

  const frameBounds = await banner.evaluate((image) => {
    const frame = image.parentElement;
    if (!frame) throw new Error("banner image has no display frame");
    return frame.getBoundingClientRect();
  });
  // CSS layout quantizes dimensions to fractional device pixels. Two decimal
  // places allow that subpixel noise while still rejecting the old responsive
  // crop ratios (about 2.03 on mobile and 5.63 on desktop).
  expect(frameBounds.width / frameBounds.height).toBeCloseTo(3, 2);

  // A 3:1 frame says nothing about its size, hence the absolute height.
  if (expectedHeight !== undefined) {
    expect(frameBounds.height).toBeCloseTo(expectedHeight, 1);
  }
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

    await expectCanonicalBannerGeometry(page.getByRole("img", { name: "Banner" }));

    await page.goto(`/@${account.username}`);
    const profileBanner = page.getByRole("img", { name: /banner/i });
    await expect(profileBanner).toHaveAttribute("src", /^\/media\/banners\//);

    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expectCanonicalBannerGeometry(profileBanner);
    }

    // 2560 is wide enough that the 1500px measure binds, making the frame
    // exactly 1500x500. Aspect alone cannot catch an unbounded frame — 2560x853
    // is as 3:1 as 1500x500 — so the absolute height is what pins the cap here.
    await page.setViewportSize({ width: 2560, height: 900 });
    await expectCanonicalBannerGeometry(profileBanner, 500);
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
    const newPassword = "correct-horse-battery-99";

    await page.goto("/settings/account");
    await page.getByLabel("Current Password").fill(account.password);
    await page.getByLabel("New Password", { exact: true }).fill(newPassword);
    await page.getByLabel("Confirm New Password").fill(newPassword);
    await page.getByRole("button", { name: "Change password" }).click();

    await expect(page.getByText("Your password has been changed.")).toBeVisible();

    // Sign-out is no longer a section on /settings/account (issue #217); sign
    // out from the own-profile action row instead.
    await page.goto(`/@${account.username}`);
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login/);

    await page.getByLabel("Username or Email").fill(account.email);
    await page.getByLabel("Password").fill(newPassword);
    await page.getByRole("main").getByRole("button", { name: "Log in" }).click();

    await expect(page).toHaveURL(new RegExp(`/@${account.username}$`));
  });
});

test.describe("preferences", () => {});
