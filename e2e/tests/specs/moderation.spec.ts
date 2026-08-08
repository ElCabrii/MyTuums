import { test, expect } from "../../support/fixtures";
import { postCardWithText } from "../../support/post-card";

/**
 * The moderation desk, walked end to end: bob posts, alice (the moderator
 * fixture — promoted in auth.setup.ts) reports the post from her feed, removes
 * it from the queue, bob's post becomes a stub in his own feed with the
 * author-only appeal link, bob appeals from the stub, and the open appeal
 * brings the case back into alice's queue.
 *
 * The review step is deliberately left out of the browser journey: `appealReview`
 * forbids the action's own actor from reviewing it, so overturning would need
 * a second moderator fixture — and the full reviewer-exclusion, uphold and
 * overturn behaviour is already covered by moderation.int.test.ts. This spec
 * proves the user-visible surface: report dialog, queue, case dialog removal,
 * stub + appeal link, appeal form, and the appeal badge in the queue.
 */
test.describe("moderation", () => {
  test("report → queue → remove → appeal", async ({ page, bobPage, db }) => {
    // Unique enough that it can't match a leftover from an earlier run: specs
    // share one database (workers: 1) and only global-setup truncates.
    const marker = `ModerationProbe${Date.now().toString()}`;
    const bobId = await db.getUserId("bob");
    const [post] = await db.seedPosts(bobId, 1, { content: () => marker });
    if (!post) throw new Error("seedPosts returned no row");

    // ── Report: alice's kebab on bob's post, reason picked in the dialog. ──
    await page.goto("/");
    await postCardWithText(page, marker).getByRole("button", { name: "More" }).click();
    await page.getByRole("menuitem", { name: "Report post" }).click();
    await expect(page.getByRole("heading", { name: "Report post" })).toBeVisible();
    // Scoped to the dialog: the reason picker is the combobox inside it (the
    // header search box is another combobox on the same page).
    await page.getByRole("dialog").getByRole("combobox").click();
    await page.getByRole("option", { name: "Spam" }).click();
    await page.getByRole("button", { name: "Report", exact: true }).click();
    await expect(page.getByText("Thanks — we'll look into it.")).toBeVisible();
    await page.keyboard.press("Escape");

    // ── Queue: alice (moderator) opens the desk and removes the post. ──
    await page.goto("/moderation");
    await expect(page.getByRole("heading", { name: "Moderation" })).toBeVisible();
    // The queue is newest-first, so the first "1 report" row is this run's
    // case even if a crashed earlier run left a stale one behind.
    await page
      .getByRole("button", { name: /1 report/ })
      .first()
      .click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(marker, { exact: true })).toBeVisible();
    await dialog.getByLabel("Reason").fill(`removed by e2e ${marker}`);
    await dialog.getByRole("button", { name: "Remove post" }).click();
    // The removal lands: the case now reads as removed, offering Restore.
    await expect(dialog.getByRole("button", { name: "Restore post" })).toBeVisible();
    await page.keyboard.press("Escape");
    // The stamps closed every open report, so the queue drains.
    await expect(page.getByText("No open cases. Nothing needs attention.")).toBeVisible();

    // ── The stub: bob sees the removal reason and the appeal link. ──
    await bobPage.goto("/");
    const stub = postCardWithText(bobPage, `removed by e2e ${marker}`);
    await expect(stub.getByText("This post was removed for violating our rules.")).toBeVisible();
    await stub.getByRole("link", { name: "Appeal this decision" }).click();
    await expect(bobPage).toHaveURL(/\/appeal\?postId=/);

    // ── The appeal: signed-in stub path, form + success state. ──
    await expect(
      bobPage.getByRole("heading", { name: "Appeal a moderation decision" }),
    ).toBeVisible();
    await bobPage
      .getByLabel("Your appeal")
      .fill("This removal was a mistake — my post followed the rules.");
    await bobPage.getByRole("button", { name: "Submit appeal" }).click();
    await expect(bobPage.getByRole("heading", { name: "Appeal submitted" })).toBeVisible();

    // ── Back in the queue: the open appeal keeps the case alive. ──
    await page.goto("/moderation");
    // Reports are stamped, so the row's summary is the appeal's own text, and
    // the open appeal is badged.
    await expect(
      page.getByText("This removal was a mistake — my post followed the rules."),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /Appeal/ })).toBeVisible();
  });
});
