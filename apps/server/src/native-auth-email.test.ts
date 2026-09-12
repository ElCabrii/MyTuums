import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "tsup";
import { Miniflare, type WorkerdStructuredLog } from "miniflare";
import { expect, it } from "vitest";
import { z } from "zod";
import { createDatabase } from "@my-tuums/db";
import { runMigrations } from "@my-tuums/db/migrate";
import { LEGAL_VERSION } from "@my-tuums/auth/rules";

const emailSchema = z.object({ subject: z.string(), html: z.string(), text: z.string() });
it("renders emails in workerd, verifies D1 accounts, and keeps provider/database failures private", async () => {
  const path = await mkdtemp(join(tmpdir(), "mytuums-auth-email-test-"));
  let runtime: Miniflare | undefined;
  const logs: WorkerdStructuredLog[] = [];
  try {
    await build({
      config: false,
      entry: {
        index: fileURLToPath(new URL("../worker/tests/auth-email-entry.ts", import.meta.url)),
      },
      platform: "neutral",
      target: "es2022",
      format: ["esm"],
      bundle: true,
      splitting: false,
      noExternal: [/.*/],
      external: [/^node:/],
      esbuildOptions(options) {
        options.conditions = ["workerd", "worker", "browser"];
      },
      outDir: path,
      silent: true,
    });
    runtime = new Miniflare({
      handleStructuredLogs: (log) => {
        logs.push(log);
      },
      workers: [
        {
          config: {
            type: "worker",
            name: "auth-email-test",
            compatibilityDate: "2026-09-11",
            compatibilityFlags: ["nodejs_compat"],
            manifest: {
              mainModule: "index.js",
              modules: {
                "index.js": {
                  type: "esm",
                  contents: await readFile(join(path, "index.js"), "utf8"),
                },
              },
            },
            env: { DB: { type: "d1", id: "auth_email_test" } },
          },
        },
      ],
    });
    const binding = await runtime.getD1Database("DB", "auth-email-test");
    const db = createDatabase(binding);
    await runMigrations(
      db,
      fileURLToPath(new URL("../../../packages/db/drizzle-d1", import.meta.url)),
    );
    // HTTP ingress preserves the browser Origin header without using the local RPC proxy.
    const dispatch = runtime.dispatchFetch;
    const origin = "https://auth-poc.example.test";
    // The former Node ESM regression now executes all three auth builders in workerd.
    const templates = z
      .array(emailSchema)
      .parse(await (await dispatch(`${origin}/auth-templates`)).json());
    expect(templates).toHaveLength(3);
    for (const template of templates) {
      expect(template.html).toContain("<html");
      expect(template.html).toContain(`src="${origin}/mytuums-192.png"`);
      expect(template.text.length).toBeGreaterThan(0);
    }
    const headers = {
      origin,
      "content-type": "application/json",
      "x-mytuums-client-ip": "203.0.113.15",
    };
    const credentials = {
      email: "native-author@example.com",
      password: "Synthetic-test-passphrase-123!",
    };
    const refused = await dispatch(`${origin}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { ...headers, origin: "https://other.example.test" },
      body: JSON.stringify({ ...credentials, name: "Wrong origin" }),
    });
    expect(refused.status).toBe(403);
    const created = await dispatch(`${origin}/api/auth/sign-up/email`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        ...credentials,
        name: "Native Author",
        username: "nativeauthor",
        legalAcceptedAt: new Date().toISOString(),
        legalVersion: LEGAL_VERSION,
      }),
    });
    expect(created.status, await created.clone().text()).toBe(200);
    expect(z.object({ token: z.null() }).parse(await created.json()).token).toBeNull();
    const messages = z
      .array(emailSchema.extend({ to: z.string() }))
      .parse(await (await dispatch(`${origin}/captured-emails`)).json());
    expect(messages).toHaveLength(1);
    const email = messages[0];
    expect(email.to).toBe(credentials.email);
    expect(email.html).toContain(`src="${origin}/mytuums-192.png"`);
    expect(email.html).not.toContain("localhost");
    const action = email.text.match(/https:\/\/[^\s]+\/api\/auth\/verify-email\?[^\s]+/);
    expect(action).not.toBeNull();
    const verificationUrl = new URL(action![0]);
    expect(verificationUrl.origin).toBe(origin);
    const beforeVerification = await dispatch(`${origin}/api/auth/sign-in/email`, {
      method: "POST",
      headers,
      body: JSON.stringify(credentials),
    });
    expect(beforeVerification.status).toBe(403);
    const verified = await dispatch(verificationUrl.href, { redirect: "manual", headers });
    expect([200, 302]).toContain(verified.status);
    const signedIn = await dispatch(`${origin}/api/auth/sign-in/email`, {
      method: "POST",
      headers,
      body: JSON.stringify(credentials),
    });
    expect(signedIn.status).toBe(200);
    expect(signedIn.headers.get("set-cookie")).toContain("better-auth.session_token");
    const moderation = emailSchema.parse(
      await (await dispatch(`${origin}/moderation-template`)).json(),
    );
    expect(moderation.html).toContain(`src="${origin}/mytuums-192.png"`);
    expect(moderation.html).toContain(`${origin}/appeal?token=synthetic`);
    expect(moderation.html).toContain("&lt;script&gt;synthetic&lt;/script&gt;");
    expect(moderation.html).not.toContain("<script>");
    expect(moderation.subject).toBe("Votre publication a été retirée de MyTuums");

    // The dependency catches delivery failures internally. Its actual workerd
    // diagnostics must preserve the failure signal without publishing the mail.
    const errorsBeforeDelivery = logs.filter((log) => log.level === "error").length;
    const failedDelivery = await dispatch(`${origin}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { ...headers, "x-mytuums-client-ip": "203.0.113.16" },
      body: JSON.stringify({
        email: "native-provider-failure@example.com",
        password: credentials.password,
        name: "Synthetic Provider Failure",
        username: "providerfailure",
        legalAcceptedAt: new Date().toISOString(),
        legalVersion: LEGAL_VERSION,
      }),
    });
    expect(failedDelivery.status).toBe(200);
    await expect
      .poll(() => logs.filter((log) => log.level === "error").length)
      .toBeGreaterThan(errorsBeforeDelivery);

    // A real D1 failure exercises the router's separate API-error handler.
    const errorsBeforeDatabase = logs.filter((log) => log.level === "error").length;
    await binding.prepare('DROP TABLE "verification"').run();
    const unavailable = await dispatch(`${origin}/api/auth/request-password-reset`, {
      method: "POST",
      headers,
      body: JSON.stringify({ email: credentials.email }),
    });
    expect(unavailable.status).toBe(500);
    expect(await unavailable.json()).toEqual({
      code: "INTERNAL_SERVER_ERROR",
      message: "Internal Server Error",
    });
    await expect
      .poll(() => logs.filter((log) => log.level === "error").length)
      .toBeGreaterThan(errorsBeforeDatabase);
    const diagnosticText = logs.map((log) => log.message).join("\n");
    for (const privateValue of [
      "synthetic-provider-credential",
      "native-provider-failure@example.com",
      credentials.email,
      "token=",
      "insert into",
      "params:",
    ]) {
      expect(diagnosticText).not.toContain(privateValue);
    }
  } finally {
    await runtime?.dispose();
    await rm(path, { recursive: true, force: true });
  }
}, 30_000);
