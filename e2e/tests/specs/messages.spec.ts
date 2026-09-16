import { openSessionAs, test, expect } from "../../support/fixtures";
import type { Page } from "@playwright/test";
import { ALICE, BOB } from "../../support/users";

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
    await expect(page.getByText(firstMessage)).toBeVisible();
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
  });
});

test.describe("messages: multi-session", () => {
  test("a message sent on one session of the account appears live on another open session", async ({
    page,
    bobPage,
    browser,
    db,
  }, testInfo) => {
    const aliceId = await db.getUserId(ALICE.username);
    const bobId = await db.getUserId(BOB.username);
    await db.deleteConversationBetween(aliceId, bobId);
    // The sender's other device shares the same hub: one account, two live
    // sessions, the same conversation open in the second one.
    const secondSession = await openSessionAs(browser, "alice", testInfo);

    try {
      // An inbox thread for alice: she follows bob, he writes. The follow is
      // seeded directly — a UI click races bob's send for the edge commit,
      // and losing it lands the thread in requests instead of the inbox.
      await db.seedFollow(aliceId, bobId);

      const opener = `from bob ${Date.now()}`;
      await bobPage.goto(`/@${ALICE.username}`);
      await bobPage.getByRole("button", { name: "More", exact: true }).first().click();
      await bobPage.getByRole("menuitem", { name: "Message" }).click();
      await bobPage.getByRole("textbox", { name: "Write a message" }).fill(opener);
      await bobPage.keyboard.press("Enter");

      // Both alice sessions open the thread from the inbox.
      const openThread = async (target: Page) => {
        await target.goto("/messages");
        const row = target.getByRole("button", { name: new RegExp(BOB.name) }).first();
        await expect(row).toBeVisible();
        await row.click();
        await expect(target.locator("section").getByText(opener)).toBeVisible();
      };
      await openThread(secondSession);
      await openThread(page);

      // Alice sends from the FIRST session; the second one receives it over
      // the event stream — no reload.
      const fromOtherSession = `from the other session ${Date.now()}`;
      await page.getByRole("textbox", { name: "Write a message" }).fill(fromOtherSession);
      await page.keyboard.press("Enter");

      await expect(secondSession.locator("section").getByText(fromOtherSession)).toBeVisible({
        timeout: 10_000,
      });
    } finally {
      await secondSession.close();
    }
  });
});
