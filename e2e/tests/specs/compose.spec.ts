import { test, expect } from "../../support/fixtures";
import type { Page } from "@playwright/test";
import { postCardWithText } from "../../support/post-card";
import { solidPng, jpegWithExif, EXIF_PROBE_STRING } from "../../support/image";
import { ALICE } from "../../support/users";

const COMPOSER_PLACEHOLDER = "Share a gaming update, clip, or tournament result...";
const REPLY_PLACEHOLDER = "Post your reply...";

/** Object storage is all-or-nothing in the E2E stack; partial credentials boot without uploads. */
function storageBucketConfigured(): boolean {
  return ["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"].every((key) =>
    Boolean(process.env[key]),
  );
}

test.describe("composing a post", () => {
  test("posting from / appears in the ranked feed only after Refresh", async ({ page, db }) => {
    const aliceId = await db.getUserId(ALICE.username);
    const [older] = await db.seedPosts(aliceId, 1, {
      content: () => `Existing feed post ${Date.now().toString()}`,
    });
    if (!older) throw new Error("seedPosts returned no row");

    await page.goto("/");

    await expect(page.getByText(older.content, { exact: true })).toBeVisible();

    const fresh = `Brand new feed post ${Date.now().toString()}`;
    await page.getByPlaceholder(COMPOSER_PLACEHOLDER).fill(fresh);
    await page.getByRole("button", { name: "Post", exact: true }).click();
    // The draft clears only after publishing succeeds; Refresh must not race it.
    await expect(page.getByPlaceholder(COMPOSER_PLACEHOLDER)).toHaveValue("");

    // Issue #305: the home feed is ranked from a frozen per-viewer snapshot,
    // and the composer mutation's auto-refetch hydrates that SAME snapshot —
    // a new candidate never joins the order until an explicit Refresh mints
    // a new one. The fresh post is therefore absent before Refresh, even
    // though the mutation already succeeded.
    await expect(page.getByText(fresh, { exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: "Refresh" }).first().click();

    // Ranked order is score-based, not chronological — assert presence after
    // Refresh, never position. (The old "new post lands on top" held only
    // for the chronological feed.)
    const freshLocator = page.getByText(fresh, { exact: true });
    const olderLocator = page.getByText(older.content, { exact: true });
    await expect(freshLocator).toBeVisible();
    await expect(olderLocator).toBeVisible();
  });

  test("long multiline drafts grow without horizontal overflow on a mobile viewport", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    const textarea = page.getByPlaceholder(COMPOSER_PLACEHOLDER);

    await textarea.fill("Short mobile draft");
    const shortBox = await textarea.boundingBox();
    if (!shortBox) throw new Error("expected the composer textarea to have a layout box");

    const nearLimit = "line\n".repeat(99) + "line";
    await textarea.fill(nearLimit);
    const longMetrics = await textarea.evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      overflowY: getComputedStyle(element).overflowY,
    }));

    expect(longMetrics.height).toBeGreaterThan(shortBox.height);
    expect(longMetrics.height).toBeLessThanOrEqual(256);
    expect(longMetrics.overflowY).toBe("auto");
    await expect(page.locator("form").getByText("1", { exact: true })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });

  test("accepting a keyboard mention posts text that LinkedText turns into a profile link", async ({
    page,
  }) => {
    await page.goto("/");
    const prefix = `Keyboard mention ${Date.now().toString()}`;
    const textarea = page.getByPlaceholder(COMPOSER_PLACEHOLDER);
    await textarea.fill(`${prefix} @al`);

    const suggestion = page.getByRole("option", { name: /Alice Anderson.*@alice/i });
    await expect(suggestion).toBeVisible();
    await textarea.press("ArrowDown");
    await expect(suggestion).toHaveAttribute("aria-selected", "true");
    await textarea.press("Tab");

    const accepted = `${prefix} @alice`;
    await expect(textarea).toHaveValue(accepted);
    await page.getByRole("button", { name: "Post", exact: true }).click();
    await expect(textarea).toHaveValue("");

    // Ranked home (issue #305): the composer refetch hydrates the same
    // snapshot, so the new post joins only after an explicit Refresh.
    await page.getByRole("button", { name: "Refresh" }).first().click();

    const post = page.getByText(accepted, { exact: true });
    await expect(post).toBeVisible();
    await expect(post.getByRole("link", { name: "@alice" })).toHaveAttribute("href", "/@alice");
  });

  test("the home draft survives a page reload", async ({ page }) => {
    await page.goto("/");
    const draft = `Unsent home draft ${Date.now().toString()}`;
    await page.getByPlaceholder(COMPOSER_PLACEHOLDER).fill(draft);

    await page.reload();

    // composerDraftAtom persists to localStorage (atoms/composer.ts).
    await expect(page.getByPlaceholder(COMPOSER_PLACEHOLDER)).toHaveValue(draft);
  });

  test("a reply draft on /post/$id does NOT survive a reload", async ({ page, db }) => {
    const aliceId = await db.getUserId(ALICE.username);
    const [seeded] = await db.seedPosts(aliceId, 1, {
      content: () => `Reply draft target ${Date.now().toString()}`,
    });
    if (!seeded) throw new Error("seedPosts returned no row");

    await page.goto(`/post/${seeded.id}`);
    const draft = `Unsent reply draft ${Date.now().toString()}`;
    await page.getByPlaceholder(REPLY_PLACEHOLDER).fill(draft);

    await page.reload();

    // The contrast with the test above is the point: replyDraftAtomFamily is
    // deliberately in-memory (atoms/reply-composer.ts) — a family of
    // localStorage keys, one per post ever replied to, would have nothing
    // able to evict them, so this one empties on reload instead of surviving it.
    await expect(page.getByPlaceholder(REPLY_PLACEHOLDER)).toHaveValue("");
  });
});

test.describe("post image attachments", () => {
  test.skip(!storageBucketConfigured(), "no Storage Bucket configured (S3_* unset)");

  test("uploads a post image and renders the stored /media/posts object", async ({ page }) => {
    await page.goto("/");
    const content = `Post with image ${Date.now().toString()}`;

    await page.getByPlaceholder(COMPOSER_PLACEHOLDER).fill(content);
    await page.getByLabel("Add images", { exact: true }).setInputFiles({
      name: "post.png",
      mimeType: "image/png",
      buffer: solidPng(800, 600),
    });
    await expect(page.getByRole("img", { name: "post.png" })).toBeVisible();

    await page.getByRole("button", { name: "Post", exact: true }).click();
    await expect(page.getByPlaceholder(COMPOSER_PLACEHOLDER)).toHaveValue("");

    // Ranked home (issue #305): the new candidate joins only after Refresh.
    await page.getByRole("button", { name: "Refresh" }).first().click();

    const card = postCardWithText(page, content);
    const image = card.getByRole("img", { name: "Attached image 1" });
    await expect(image).toHaveAttribute("src", /^\/media\/posts\//, { timeout: 20_000 });
    const src = await image.getAttribute("src");
    if (!src) throw new Error("expected the stored post image to have a source");
    const response = await page.request.get(src);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("image");
  });

  test("uploads and renders the same attachment capability on a reply", async ({ page, db }) => {
    const aliceId = await db.getUserId(ALICE.username);
    const [parent] = await db.seedPosts(aliceId, 1, {
      content: () => `Reply image parent ${Date.now().toString()}`,
    });
    if (!parent) throw new Error("seedPosts returned no parent post");

    await page.goto(`/post/${parent.id}`);
    const content = `Reply with image ${Date.now().toString()}`;
    await page.getByPlaceholder(REPLY_PLACEHOLDER).fill(content);
    await page.getByLabel("Add images", { exact: true }).setInputFiles({
      name: "reply.png",
      mimeType: "image/png",
      buffer: solidPng(640, 480),
    });
    await expect(page.getByRole("img", { name: "reply.png" })).toBeVisible();

    await page.getByRole("button", { name: "Reply", exact: true }).click();

    const card = postCardWithText(page, content);
    const image = card.getByRole("img", { name: "Attached image 1" });
    await expect(image).toHaveAttribute("src", /^\/media\/posts\//, { timeout: 20_000 });
    const src = await image.getAttribute("src");
    if (!src) throw new Error("expected the stored reply image to have a source");
    const response = await page.request.get(src);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("image");
  });

  test("stores a re-encoded attachment without the picked file's metadata", async ({ page }) => {
    // Issue #207: what lands in storage must be the browser's re-encode, not
    // the picked bytes. The fixture is a real JPEG whose EXIF names a camera
    // and carries GPS coordinates; none of it may survive into the stored
    // object, and the stored object must not even be a JPEG — the composer
    // re-encodes to WebP (PNG on browsers without that encoder).
    await page.goto("/");
    const content = `Metadata strip ${Date.now().toString()}`;

    await page.getByPlaceholder(COMPOSER_PLACEHOLDER).fill(content);
    await page.getByLabel("Add images", { exact: true }).setInputFiles({
      name: "gps-photo.jpg",
      mimeType: "image/jpeg",
      buffer: jpegWithExif(320, 240),
    });
    await expect(page.getByRole("img", { name: "gps-photo.jpg" })).toBeVisible();

    await page.getByRole("button", { name: "Post", exact: true }).click();
    await expect(page.getByPlaceholder(COMPOSER_PLACEHOLDER)).toHaveValue("");

    // Ranked home (issue #305): the new candidate joins only after Refresh.
    await page.getByRole("button", { name: "Refresh" }).first().click();

    const card = postCardWithText(page, content);
    const image = card.getByRole("img", { name: "Attached image 1" });
    await expect(image).toHaveAttribute("src", /^\/media\/posts\//, { timeout: 20_000 });
    const src = await image.getAttribute("src");
    if (!src) throw new Error("expected the stored post image to have a source");
    const response = await page.request.get(src);
    expect(response.status()).toBe(200);

    expect(response.headers()["content-type"]).toMatch(/^image\/(webp|png)$/);

    // latin1 maps bytes to code points one-to-one, so ASCII metadata
    // fragments remain greppable in the binary payload.
    const body = (await response.body()).toString("latin1");
    expect(body.includes(EXIF_PROBE_STRING)).toBe(false);
    expect(body.includes("Exif")).toBe(false);
    expect(body.includes("GPS Spy Unit")).toBe(false);
  });
});

test.describe("composer visibility layout (issue #350)", () => {
  // Mirrored from apps/web/messages/{en,fr}.json by hand, so the spec
  // disagrees with the code by construction when copy drifts (e2e/CONTEXT.md).
  const EN = {
    placeholder: COMPOSER_PLACEHOLDER,
    addImages: "Add images",
    triggerPattern: /Post visibility/,
    triggerPublic: "Post visibility: Public",
    title: "Post visibility",
    audience: "Public",
    publicOption: "Public",
    followersOption: "Followers only",
  } as const;
  const FR = {
    placeholder: "Partagez une actualité gaming, un clip ou un résultat de tournoi...",
    addImages: "Ajouter des images",
    triggerPattern: /Visibilité de la publication/,
    triggerPublic: "Visibilité de la publication : Public",
    title: "Visibilité de la publication",
    audience: "Public",
    publicOption: "Public",
    followersOption: "Abonnés uniquement",
  } as const;

  // either side of Tailwind's sm breakpoint (640px), plus common phone widths.
  const WIDTHS = [320, 360, 390, 639, 640, 641] as const;
  const HEIGHT = 844;

  async function switchToFrench(page: Page): Promise<void> {
    await page.getByRole("button", { name: "Language" }).click();
    await page.getByRole("menuitem", { name: "French" }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "fr");
    await expect(page.getByPlaceholder(FR.placeholder)).toBeVisible();
  }

  async function switchToEnglish(page: Page): Promise<void> {
    await page.getByRole("button", { name: "Langue" }).click();
    await page.getByRole("menuitem", { name: "English" }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
  }

  test("visibility trigger stays adjacent to Add images without overflow from 320 to 641px in EN and FR", async ({
    page,
  }) => {
    test.slow();
    // PostComposer mounts on both the home feed and one's own profile
    // (components/profile-posts.tsx); the toolbar is the same component, so
    // both routes pin the same geometry.
    const routes = ["/", `/@${ALICE.username}`] as const;

    for (const strings of [EN, FR]) {
      if (strings === FR) await switchToFrench(page);

      for (const route of routes) {
        await page.goto(route);
        const textarea = page.getByPlaceholder(strings.placeholder);
        await expect(textarea).toBeVisible();
        const form = page.locator("form", { has: textarea });
        const trigger = form.getByRole("button", { name: strings.triggerPattern });
        // The accessible name carries the audience at every width, even when
        // the visible audience text hides below sm.
        await expect(trigger).toHaveAccessibleName(strings.triggerPublic);
        // The longer audience label is the tightest toolbar layout in both locales.
        await trigger.click();
        await page.getByRole("radio", { name: strings.followersOption }).click();
        await page.keyboard.press("Escape");
        const audience = trigger.getByText(strings.followersOption, { exact: true });
        const addImagesPill = form.locator("label", {
          has: page.getByLabel(strings.addImages, { exact: true }),
        });
        await expect(addImagesPill).toBeVisible();

        for (const width of WIDTHS) {
          await page.setViewportSize({ width, height: HEIGHT });
          await expect(trigger).toBeVisible();

          const [triggerBox, pillBox, submitBox, counterBox] = await Promise.all([
            trigger.boundingBox(),
            addImagesPill.boundingBox(),
            form.locator('button[type="submit"]').boundingBox(),
            form.locator('span[aria-live="polite"]').boundingBox(),
          ]);
          if (!triggerBox || !pillBox || !submitBox || !counterBox) {
            throw new Error(`expected the composer toolbar to have layout boxes at ${width}px`);
          }

          // Same action row: vertical centers align and the two pills never overlap.
          const centerDelta = Math.abs(
            triggerBox.y + triggerBox.height / 2 - (pillBox.y + pillBox.height / 2),
          );
          expect(centerDelta).toBeLessThan(12);
          const overlaps =
            triggerBox.x < pillBox.x + pillBox.width &&
            pillBox.x < triggerBox.x + triggerBox.width &&
            triggerBox.y < pillBox.y + pillBox.height &&
            pillBox.y < triggerBox.y + triggerBox.height;
          expect(overlaps).toBe(false);

          for (const box of [triggerBox, pillBox, submitBox, counterBox]) {
            expect(box.x).toBeGreaterThanOrEqual(0);
            expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
          }
          expect(counterBox.x + counterBox.width).toBeLessThanOrEqual(submitBox.x);
          expect(
            submitBox.y >= triggerBox.y + triggerBox.height ||
              counterBox.x >= triggerBox.x + triggerBox.width,
          ).toBe(true);

          if (width < 640) await expect(audience).toBeHidden();
          else await expect(audience).toBeVisible();

          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          ).toBe(true);
        }
      }
    }

    await switchToEnglish(page);
  });

  test("visibility popover fits a 320px viewport and Escape returns focus", async ({ page }) => {
    test.slow();
    // Narrowest supported width is the worst case for a popover; the home
    // composer is the same PostComposer as the profile one, so one route pins it.
    await page.setViewportSize({ width: 320, height: HEIGHT });

    for (const strings of [EN, FR]) {
      if (strings === FR) await switchToFrench(page);

      await page.goto("/");
      const textarea = page.getByPlaceholder(strings.placeholder);
      await expect(textarea).toBeVisible();
      const form = page.locator("form", { has: textarea });
      const trigger = form.getByRole("button", { name: strings.triggerPattern });
      await expect(trigger).toHaveAccessibleName(strings.triggerPublic);

      await trigger.click();
      const title = page.getByText(strings.title, { exact: true });
      const publicOption = page.getByRole("radio", { name: strings.publicOption });
      const followersOption = page.getByRole("radio", { name: strings.followersOption });
      await expect(title).toBeVisible();
      await expect(publicOption).toBeVisible();
      await expect(followersOption).toBeVisible();

      for (const target of [title, publicOption, followersOption]) {
        const box = await target.boundingBox();
        if (!box) throw new Error("expected the visibility popover to have a layout box");
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(320 + 1);
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.y + box.height).toBeLessThanOrEqual(HEIGHT + 1);
      }
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);

      await page.keyboard.press("Escape");
      await expect(title).toBeHidden();
      await expect(trigger).toBeFocused();
    }

    await switchToEnglish(page);
  });
});
