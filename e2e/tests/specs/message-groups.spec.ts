import { test, expect } from "../../support/fixtures";
import { ALICE, BOB } from "../../support/users";

// The browser-specific contract: create/join navigation and live membership
// changes must reconcile both open panes without a reload.
test("group invitations join the same live thread and removal closes the other browser's pane", async ({
  page,
  bobPage,
}) => {
  const name = `Friends ${Date.now()}`;
  await page.goto("/messages");
  await page.getByRole("button", { name: "New group" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Group name").fill(name);
  await dialog.getByLabel("Invite people").fill(BOB.username);
  await dialog.getByRole("button", { name: "Search", exact: true }).click();
  await dialog.getByRole("button", { name: `${BOB.name} @${BOB.username}`, exact: true }).click();
  await dialog.getByRole("button", { name: "New group", exact: true }).click();
  await expect(page).toHaveURL(/\/messages\/[0-9a-f-]{36}$/);
  await page.getByRole("textbox", { name: "Write a message" }).fill("Welcome to our group");
  await page.getByRole("textbox", { name: "Write a message" }).press("Enter");
  await expect(page.locator("section").getByText("Welcome to our group")).toBeVisible();

  await bobPage.goto("/messages/requests");
  const invitation = bobPage.locator("section").getByText(name, { exact: true }).locator("../..");
  await invitation.getByRole("button", { name: "Join", exact: true }).click();
  await expect(bobPage).toHaveURL(page.url());
  await expect(bobPage.locator("section").getByText("Welcome to our group")).toBeVisible();
  await bobPage.getByRole("textbox", { name: "Write a message" }).fill("Hello everyone");
  await bobPage.getByRole("textbox", { name: "Write a message" }).press("Enter");
  await expect(page.locator("section").getByText("Hello everyone")).toBeVisible();
  await expect(page.locator("section").getByText(BOB.name, { exact: true })).toBeVisible();

  // Bob has exactly the same permissions as the creator.
  await bobPage.getByRole("button", { name: "Members (2)" }).click();
  const details = bobPage.getByRole("dialog");
  await details.getByLabel("Group name").fill(`${name} renamed`);
  await details.getByRole("button", { name: "Save name" }).click();
  await expect(page.getByRole("heading", { name: `${name} renamed` })).toBeVisible();
  await bobPage.getByRole("button", { name: "Members (2)" }).click();
  await details
    .getByRole("listitem")
    .filter({ hasText: ALICE.name })
    .getByRole("button", { name: "Remove", exact: true })
    .click();
  await details.getByRole("button", { name: "Remove", exact: true }).last().click();
  await expect(page.getByRole("textbox", { name: "Write a message" })).toHaveCount(0);
  await expect(page.locator("section").getByText("Hello everyone")).toHaveCount(0);
});
