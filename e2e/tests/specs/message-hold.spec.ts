import { test, expect } from "../../support/fixtures";
import { BOB } from "../../support/users";

test.use({ viewport: { width: 393, height: 760 }, hasTouch: true });

test("mobile messages have no invisible delete target and require a hold then an explicit action", async ({
  page,
  db,
}) => {
  await page.goto(`/messages/new/${await db.getUserId(BOB.username)}`);
  const text = `Hold to act ${Date.now()}`;
  await page.getByRole("textbox", { name: "Write a message" }).fill(text);
  const sent = page.waitForResponse(
    (response) => response.url().includes("/message/send") && response.ok(),
  );
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await sent;
  const message = page.locator("section").getByText(text);
  await expect(message).toBeVisible();
  // Opacity alone used to hide the icon while leaving a destructive tap target.
  await expect(page.getByRole("button", { name: "Delete message", exact: true })).toHaveCount(0);

  // Real elapsed time models a finger hold; freezing the browser clock would
  // also freeze the dialog animations and Playwright's actionability checks.
  const cdp = await page.context().newCDPSession(page);
  const bounds = await message.boundingBox();
  if (!bounds) throw new Error("Message is outside the viewport");
  const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  const start = () =>
    cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
  const end = () => cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });

  // Tapping, moving to scroll, and cancelled touches must not open actions.
  await start();
  await end();
  await page.waitForTimeout(600);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await start();
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ ...point, y: point.y - 35 }],
  });
  await page.waitForTimeout(600);
  await end();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await start();
  await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
  await page.waitForTimeout(600);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await start();
  await page.waitForTimeout(600);
  await end();
  const actions = page.getByRole("dialog", { name: "Message actions" });
  await expect(actions).toBeVisible();
  await expect(message).toBeVisible();
  await actions.getByRole("button", { name: "Close", exact: true }).click();

  // The same touch input on a desktop-sized layout retains desktop behavior.
  await page.setViewportSize({ width: 1280, height: 800 });
  const desktopBounds = await message.boundingBox();
  if (!desktopBounds) throw new Error("Desktop message is outside the viewport");
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: desktopBounds.x + 10, y: desktopBounds.y + 10 }],
  });
  await page.waitForTimeout(600);
  await end();
  await expect(actions).toHaveCount(0);
  await message.hover();
  await expect(page.getByRole("button", { name: "Delete message", exact: true })).toBeVisible();

  await page.setViewportSize({ width: 393, height: 760 });
  await start();
  await page.waitForTimeout(600);
  await end();
  const deleted = page.waitForResponse(
    (response) => response.url().includes("/message/deleteMessage") && response.ok(),
  );
  await actions.getByRole("button", { name: "Delete message", exact: true }).click();
  await deleted;
  await expect(message).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Write a message" })).toBeVisible();
  await expect(page.locator("section").getByText(text)).toHaveCount(0);
  await cdp.detach();
});
