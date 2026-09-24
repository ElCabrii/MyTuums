import { unlockMessages } from "../../support/messages";
import { test, expect } from "../../support/fixtures";
import type { Page } from "@playwright/test";
import { ALICE, BOB, uniqueUser } from "../../support/users";
import { E2E_SERVER_ORIGIN, E2E_WEB_ORIGIN } from "../../constants";

/**
 * The private-messages journey (issue #408): bob's first message to alice —
 * someone he does not follow being followed by — lands as a request rather
 * than ticking her badge; accepting moves it to the inbox; and alice's reply
 * reaches bob's already-open thread live, over the event stream. The rules
 * themselves — request gating, silent declines, unread cursors, tombstones —
 * are pinned by `packages/api/src/messages.int.test.ts`; this spec proves
 * only the crossings a browser owns: the badge, the requests entry, and the
 * live delivery.
 */

/** The header mail action's current unread count, 0 when it carries no badge. */
async function unreadOnMail(page: Page): Promise<number> {
  const mail = page.getByRole("button", { name: /^Messages/ });
  const label = (await mail.getAttribute("aria-label")) ?? "";
  const match = label.match(/(\d+)/);
  return match ? Number(match[1]) : 0;
}

test.describe("messages", () => {
  test("visiting Home prepares messaging automatically across simultaneous tabs", async ({
    page,
    db,
  }) => {
    const user = uniqueUser("autokeys");
    await db.createUser(user);
    await page.context().clearCookies();
    const login = await page.request.post(`${E2E_SERVER_ORIGIN}/api/auth/sign-in/email`, {
      headers: { Origin: E2E_WEB_ORIGIN },
      data: { email: user.email, password: user.password },
    });
    expect(login.ok()).toBe(true);
    const otherTab = await page.context().newPage();
    try {
      const registration = page.context().waitForEvent("response", {
        predicate: (response) => response.url().endsWith("/rpc/messageKey/register"),
      });
      await Promise.all([page.goto("/"), otherTab.goto("/")]);
      expect((await registration).ok()).toBe(true);
      for (const tab of [page, otherTab]) {
        await tab.getByRole("button", { name: "Messages", exact: true }).click();
        await expect(tab.getByRole("heading", { name: "Messages", exact: true })).toBeVisible();
        await expect(
          tab.getByRole("button", { name: "Recover message history by email" }),
        ).toHaveCount(0);
      }
    } finally {
      await otherTab.close();
    }
  });

  test("mobile scrolling keeps the composer against navigation and its single line centered", async ({
    page,
    bobPage,
    db,
  }) => {
    await page.setViewportSize({ width: 393, height: 760 });
    // Layout checks must not consume the recovery journeys' hourly allowance.
    const sender = uniqueUser("layout");
    const recipient = uniqueUser("recipient");
    for (const [target, user] of [
      [page, sender],
      [bobPage, recipient],
    ] as const) {
      await db.createUser(user);
      await target.context().clearCookies();
      const login = await target.request.post(`${E2E_SERVER_ORIGIN}/api/auth/sign-in/email`, {
        headers: { Origin: E2E_WEB_ORIGIN },
        data: { email: user.email, password: user.password },
      });
      expect(login.ok()).toBe(true);
      await unlockMessages(target, user.email);
    }
    await page.goto(`/messages/new/${await db.getUserId(recipient.username)}`);
    const composer = page.getByRole("textbox", { name: "Write a message" });
    await expect(composer).toBeVisible();

    // Desktop Chromium has no collapsing address bar: model mobile's large
    // viewport being 80px taller than its visible (dynamic) viewport. Keep
    // this override limited to Tailwind's actual 100vh utility.
    await page.addStyleTag({ content: ".min-h-screen { min-height: calc(100dvh + 80px); }" });
    const message = Array.from({ length: 35 }, (_, i) => `Mobile scroll regression line ${i}`).join(
      "\n",
    );
    await composer.fill(message);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(
      page.locator("section").getByText(/Mobile scroll regression line 34/),
    ).toBeVisible();
    await expect(composer).toHaveValue("");

    const navigation = page
      .getByRole("navigation", { name: "Primary navigation", includeHidden: true })
      .last();
    const footer = page.locator("main footer");
    for (const height of [760, 480, 840]) {
      await page.setViewportSize({ width: 393, height });
      await page.mouse.move(190, 220);
      await page.mouse.wheel(0, 2000);
      await expect
        .poll(async () => {
          const bottom = await footer.boundingBox();
          const nav = await navigation.boundingBox();
          return bottom && nav ? Math.abs(nav.y - bottom.y - bottom.height) : Infinity;
        })
        .toBeLessThanOrEqual(1);
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
    }

    const lineOffset = await composer.evaluate((element) => {
      const style = getComputedStyle(element);
      const lineCenter = parseFloat(style.paddingTop) + parseFloat(style.lineHeight) / 2;
      return Math.abs(element.clientHeight / 2 - lineCenter);
    });
    expect(lineOffset, "The empty message line should be vertically centered").toBeLessThanOrEqual(
      1,
    );

    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(navigation).toBeHidden();
    await expect
      .poll(async () => {
        const bounds = await footer.boundingBox();
        return bounds ? Math.abs(800 - bounds.y - bounds.height) : Infinity;
      })
      .toBeLessThanOrEqual(1);
  });

  test("a first message lands as a request, accepting moves it to the inbox, and the reply arrives live", async ({
    page,
    bobPage,
    db,
  }) => {
    const aliceId = await db.getUserId(ALICE.username);
    const bobId = await db.getUserId(BOB.username);
    // Earlier attempts (and earlier runs) leave the pair's conversation
    // accepted and active: a repeat "first" message would land straight in
    // the inbox. Resetting the pair makes the request gate assertable.
    await db.deleteConversationBetween(aliceId, bobId);
    await unlockMessages(page, ALICE.email);
    await unlockMessages(bobPage, BOB.email);

    // Bob opens the message composer from alice's profile and sends the
    // first message — the conversation is created by the send itself.
    await bobPage.goto(`/@${ALICE.username}`);
    // `.first()` — the profile's own kebab renders before the activity feed,
    // whose post cards carry a "More" kebab of their own once earlier specs
    // have seeded posts on this profile.
    await bobPage.getByRole("button", { name: "More", exact: true }).first().click();
    await bobPage.getByRole("menuitem", { name: "Message" }).click();
    await expect(bobPage).toHaveURL(/\/messages\/new\//);
    const firstMessage = `journey hello ${Date.now()}`;
    await bobPage.getByRole("textbox", { name: "Write a message" }).fill(firstMessage);
    await bobPage.keyboard.press("Enter");
    // The pane replaces the draft route with the real thread.
    await expect(bobPage).toHaveURL(/\/messages\/[0-9a-f-]{36}$/);
    // Scoped to the thread pane: the conversation list's preview row carries
    // the same words, and an unscoped getByText would match both.
    await expect(bobPage.locator("section").getByText(firstMessage)).toBeVisible();

    // Alice's side: a request, not an inbox row — her mail badge stays flat
    // while the requests entry carries its own count.
    await page.goto("/messages");
    await expect(page.getByText("Message requests")).toBeVisible();
    await expect.poll(async () => unreadOnMail(page), { timeout: 10_000 }).toBe(0);
    await expect(page.getByRole("link", { name: /Message requests.*1/ })).toBeVisible();

    await page.getByRole("link", { name: /Message requests/ }).click();
    await expect(page).toHaveURL(/\/messages\/requests$/);
    await expect(page.getByText("Encrypted message", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Accept" }).click();

    // The accepted conversation is in her inbox; opening it shows the
    // message, and her reply is the live-delivery half.
    await page.goto("/messages");
    const thread = page.getByRole("button", { name: new RegExp(BOB.name) }).first();
    await expect(thread).toBeVisible();
    await thread.click();
    await expect(page.locator("section").getByText(firstMessage)).toBeVisible();
    const reply = `journey reply ${Date.now()}`;
    await page.getByRole("textbox", { name: "Write a message" }).fill(reply);
    await page.keyboard.press("Enter");

    // Bob's thread has been open the whole time: the reply arrives over the
    // event stream without a reload. Reading it also retires his badge —
    // his side was active from the first send.
    await expect(bobPage.locator("section").getByText(reply)).toBeVisible({
      timeout: 10_000,
    });
    await expect.poll(async () => unreadOnMail(bobPage), { timeout: 10_000 }).toBe(0);

    // Recovery without the push: a reload of alice's thread keeps the
    // exchange, and her badge stays flat — she read it by opening it.
    await page.reload();
    await expect(page.locator("section").getByText(reply)).toBeVisible();
    await expect.poll(async () => unreadOnMail(page), { timeout: 10_000 }).toBe(0);
    const threadUrl = page.url();
    await page.evaluate(
      () =>
        new Promise<void>((resolve, reject) => {
          const request = indexedDB.deleteDatabase("mytuums-message-keys-v1");
          request.onsuccess = () => resolve();
          request.onerror = () => reject(new Error("Could not clear local message keys."));
          request.onblocked = () => reject(new Error("Message key database is still open."));
        }),
    );
    await unlockMessages(page, ALICE.email);
    await page.goto(threadUrl);
    await expect(page.locator("section").getByText(reply)).toBeVisible();
  });
});

test.describe("messages: multi-session", () => {
  test("a message sent on one session of the account appears live on another open session", async ({
    page,
    bobPage,
    browser,
    db,
  }) => {
    // Earlier signed-in journeys prepare Alice's keys automatically. Reusing
    // her account here would spend a fourth recovery email in the full suite.
    const sender = uniqueUser("syncsender");
    const recipient = uniqueUser("syncrecipient");
    for (const [target, user] of [
      [page, sender],
      [bobPage, recipient],
    ] as const) {
      await db.createUser(user);
      await target.context().clearCookies();
      const login = await target.request.post(`${E2E_SERVER_ORIGIN}/api/auth/sign-in/email`, {
        headers: { Origin: E2E_WEB_ORIGIN },
        data: { email: user.email, password: user.password },
      });
      expect(login.ok()).toBe(true);
      await unlockMessages(target, user.email);
    }
    const senderId = await db.getUserId(sender.username);
    const recipientId = await db.getUserId(recipient.username);
    // Carry authentication and UI preferences into another browser, but no
    // IndexedDB keys: this device must recover the sender's existing identity.
    const secondContext = await browser.newContext({
      storageState: await page.context().storageState({ indexedDB: false }),
    });
    const secondSession = await secondContext.newPage();

    try {
      // The sender follows the recipient, who opens an inbox thread. The follow is
      // seeded directly — a UI click races the opening message for the edge commit,
      // and losing it lands the thread in requests instead of the inbox.
      await db.seedFollow(senderId, recipientId);

      const opener = `from recipient ${Date.now()}`;
      await bobPage.goto(`/@${sender.username}`);
      await bobPage.getByRole("button", { name: "More", exact: true }).first().click();
      await bobPage.getByRole("menuitem", { name: "Message" }).click();
      await bobPage.getByRole("textbox", { name: "Write a message" }).fill(opener);
      await bobPage.keyboard.press("Enter");

      // Both sender sessions open the thread from the inbox.
      const openThread = async (target: Page) => {
        await target.goto("/messages");
        const row = target.getByRole("button", { name: new RegExp(recipient.name) }).first();
        await expect(row).toBeVisible();
        await row.click();
        await expect(target.locator("section").getByText(opener)).toBeVisible();
      };
      await unlockMessages(secondSession, sender.email);
      await openThread(secondSession);
      await openThread(page);

      // The sender writes from the FIRST session; the second one receives it over
      // the event stream — no reload.
      const fromOtherSession = `from the other session ${Date.now()}`;
      await page.getByRole("textbox", { name: "Write a message" }).fill(fromOtherSession);
      await page.keyboard.press("Enter");

      await expect(secondSession.locator("section").getByText(fromOtherSession)).toBeVisible({
        timeout: 10_000,
      });
    } finally {
      await secondContext.close();
    }
  });
});
