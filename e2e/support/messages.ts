import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { z } from "zod";
import { testPlatform } from "./platform";

/** Real browser key generation and fresh-email recovery; captured mail stays in the isolated E2E bucket. */
export async function unlockMessages(page: Page, email: string) {
  await page.goto("/messages");
  const setup = page.getByRole("button", { name: "Enable encrypted messaging" });
  const recover = page.getByRole("button", { name: "Recover message history by email" });
  const unlocked = page.getByRole("heading", { name: "Messages", exact: true });
  await expect(setup.or(recover).or(unlocked)).toBeVisible();
  if (await setup.isVisible()) {
    await setup.click();
  } else if (await recover.isVisible()) {
    const { bucket } = await testPlatform();
    const before = new Set(
      (await bucket.list({ prefix: "__e2e_emails/" })).objects.map((entry) => entry.key),
    );
    await recover.click();
    let code: string | null = null;
    await expect
      .poll(async () => {
        const objects = await bucket.list({ prefix: "__e2e_emails/" });
        for (const entry of objects.objects) {
          if (before.has(entry.key)) continue;
          const object = await bucket.get(entry.key);
          if (!object) continue;
          const message = z.object({ to: z.string(), text: z.string() }).parse(await object.json());
          if (message.to === email) code = message.text.match(/[A-F0-9]{16}/)?.[0] ?? null;
        }
        return code !== null;
      })
      .toBe(true);
    await page.getByLabel("Message recovery code").fill(code ?? "");
    await page.getByRole("button", { name: "Unlock messages", exact: true }).click();
  }
  await expect(unlocked).toBeVisible();
}
