import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import type { Workflow } from "@cloudflare/workers-types";
import { z } from "zod";
import { mediaIntent } from "@my-tuums/db/schema";
import { LEGAL_VERSION } from "@my-tuums/auth/rules";
import { createDevelopmentPlatform } from "./development-platform.js";

it("keeps development accounts and captured mail across restarts while refusing hosted admission", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mytuums-development-test-"));
  let platform: Awaited<ReturnType<typeof createDevelopmentPlatform>> | undefined;
  try {
    platform = await createDevelopmentPlatform(directory, 0);
    for (const url of [
      "https://localhost:3001/health",
      "http://attacker.example:3001/health",
      "https://mytuums.com/health",
    ])
      expect((await platform.runtime.dispatchFetch(url)).status).toBe(404);
    const signup = await platform.runtime.dispatchFetch(
      "http://localhost:3001/api/auth/sign-up/email",
      {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:5173" },
        body: JSON.stringify({
          name: "Local Developer",
          username: "localdev",
          email: "local@example.test",
          password: "local-test-password-123",
          dateOfBirth: "2000-01-01T00:00:00.000Z",
          legalVersion: LEGAL_VERSION,
          legalAcceptedAt: new Date().toISOString(),
        }),
      },
    );
    expect(signup.status).toBe(200);
    await platform.dispose();
    platform = undefined;
    platform = await createDevelopmentPlatform(directory, 0);
    const inbox = await platform.runtime.dispatchFetch("http://localhost:3001/__dev/emails");
    const messages = z
      .array(z.object({ message: z.object({ to: z.string(), text: z.string() }) }))
      .parse(await inbox.json());
    expect(messages).toHaveLength(1);
    expect(messages[0]?.message.to).toBe("local@example.test");
    const verification = messages[0]?.message.text.match(
      /http:\/\/localhost:5173\/api\/auth\/verify-email\?[^\s]+/,
    )?.[0];
    if (!verification) throw new Error("Local email did not contain a verification link.");
    const confirmed = await platform.runtime.dispatchFetch(
      verification.replace(":5173/", ":3001/"),
      { redirect: "manual" },
    );
    expect([200, 302]).toContain(confirmed.status);
    const signin = await platform.runtime.dispatchFetch(
      "http://localhost:3001/api/auth/sign-in/email",
      {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:5173" },
        body: JSON.stringify({ email: "local@example.test", password: "local-test-password-123" }),
      },
    );
    expect(signin.status).toBe(200);
    expect(signin.headers.get("set-cookie")).toContain("better-auth.session_token");
    expect(
      (
        await platform.runtime.dispatchFetch("http://localhost:3001/__dev/maintenance", {
          method: "POST",
        })
      ).status,
    ).toBe(403);
    const bucket = await platform.runtime.getR2Bucket("MEDIA", "development-app");
    const key = `posts/localdev/${crypto.randomUUID()}/${crypto.randomUUID()}.webp`;
    await bucket.put(key, "local disposable image");
    await platform.db.insert(mediaIntent).values({
      scope: "local-test",
      kind: "cleanup",
      paths: [`/media/${key}`],
      readyAt: new Date(0),
    });
    const jobsDb = await platform.runtime.getD1Database("DB", "development-jobs");
    expect(await jobsDb.prepare("select count(*) as count from media_intent").first("count")).toBe(
      1,
    );
    const cleanup = await platform.runtime.dispatchFetch(
      "http://localhost:3001/__dev/maintenance",
      { method: "POST", headers: { "x-mytuums-local-dev": "1" } },
    );
    expect(cleanup.status).toBe(202);
    const { id } = z.object({ id: z.string() }).parse(await cleanup.json());
    const bindings = await platform.runtime.getBindings<{
      MAINTENANCE_WORKFLOW: Workflow<{ entityId: string }>;
    }>("development-app");
    const instance = await bindings.MAINTENANCE_WORKFLOW.get(id);
    await expect
      .poll(async () => (await instance.status()).status, { timeout: 20000 })
      .toBe("complete");
    expect(Boolean(await bucket.head(key))).toBe(false);
    expect(await platform.db.select().from(mediaIntent)).toEqual([]);
  } finally {
    await platform?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 60000);
