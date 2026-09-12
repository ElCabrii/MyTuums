import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Miniflare, Response as LocalResponse, type WorkerOptions } from "miniflare";
import { unstable_readConfig as readConfig } from "wrangler";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { expect, it } from "vitest";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { SimpleCsrfProtectionLinkPlugin } from "@orpc/client/plugins";
import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "@my-tuums/api/cloudflare-app";
import { z } from "zod";
import { createDatabase } from "@my-tuums/db";
import { runMigrations } from "@my-tuums/db/migrate";
import { LEGAL_VERSION } from "@my-tuums/auth/rules";

it("boots the Wrangler application artifact with native bindings behind Access", async () => {
  // Build the web app and server build:worker first. This is the deployable artifact,
  // with only provider delivery replaced by an isolated synthetic service.
  const directory = fileURLToPath(new URL("../", import.meta.url));
  const config = z
    .object({
      compatibility_date: z.string(),
      compatibility_flags: z.array(z.string()),
      workers_dev: z.literal(false),
      preview_urls: z.literal(false),
      assets: z.object({
        directory: z.string(),
        binding: z.literal("ASSETS"),
        run_worker_first: z.literal(true),
        html_handling: z.literal("none"),
        not_found_handling: z.literal("none"),
      }),
      vars: z.object({
        WEB_ORIGIN: z.url(),
        ACCESS_TEAM_DOMAIN: z.url(),
        ACCESS_AUDIENCE: z.string(),
        CLOUDFLARE_ACCOUNT_ID: z.string(),
        STREAM_NAMESPACE: z.string(),
        EMAIL_FROM: z.email(),
      }),
      secrets: z.object({ required: z.array(z.string()) }),
    })
    .parse(readConfig({ config: resolve(directory, "wrangler.jsonc") }));
  const { WEB_ORIGIN: origin, ACCESS_TEAM_DOMAIN: issuer, ACCESS_AUDIENCE: audience } = config.vars;
  const key = await generateKeyPair("RS256");
  const jwk = {
    ...(await exportJWK(key.publicKey)),
    kid: "synthetic-app",
    alg: "RS256",
    use: "sig",
  };
  const token = await new SignJWT({
    iss: issuer,
    aud: [audience],
    exp: Math.floor(Date.now() / 1000) + 3600,
  })
    .setProtectedHeader({ alg: "RS256", kid: jwk.kid })
    .sign(key.privateKey);
  const contents = await readFile(resolve(directory, ".wrangler/dist/index.js"), "utf8");
  const externalRequests: string[] = [];
  const secretValues = Object.fromEntries(
    config.secrets.required.map((name) => [
      name,
      name === "BETTER_AUTH_SECRET" || name === "APPEAL_TOKEN_SECRET"
        ? "synthetic-app-secret-at-least-32-characters"
        : `synthetic-${name}`,
    ]),
  );
  function worker(
    name: string,
    secret: string,
    variables: Record<string, string> = {},
  ): WorkerOptions {
    return {
      config: {
        type: "worker",
        name,
        compatibilityDate: config.compatibility_date,
        compatibilityFlags: config.compatibility_flags,
        manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents } } },
        exports: {
          RateLimitCounter: { type: "durable-object", storage: "sqlite" },
          AuthRateLimitCounter: { type: "durable-object", storage: "sqlite" },
        },
        env: {
          ...Object.fromEntries(
            Object.entries({
              ...config.vars,
              ...variables,
              ...secretValues,
              BETTER_AUTH_SECRET: secret,
            }).map(([name, value]) => [name, { type: "json" as const, value }]),
          ),
          DB: { type: "d1", id: "application_entry_test" },
          MEDIA: { type: "r2", name: "application-entry-test", jurisdiction: "eu" },
          IMAGES: { type: "images", dev: { remote: false } },
          EMAIL: { type: "worker", worker: "providers" },
          STREAM: { type: "worker", worker: "providers" },
          VIDEO_WORKFLOW: { type: "worker", worker: "providers" },
          API_COUNTERS: { type: "durable-object", worker: name, exportName: "RateLimitCounter" },
          AUTH_COUNTERS: {
            type: "durable-object",
            worker: name,
            exportName: "AuthRateLimitCounter",
          },
          ASSETS: { type: "assets" },
        },
        assets: {
          directory: resolve(directory, config.assets.directory),
          hasUserWorker: true,
          runWorkerFirst: config.assets.run_worker_first,
          htmlHandling: config.assets.html_handling,
          notFoundHandling: config.assets.not_found_handling,
        },
      },
      dev: {
        outboundService: {
          type: "fetcher",
          handler(request) {
            externalRequests.push(request.url);
            return Promise.resolve(
              request.url === `${issuer}/cdn-cgi/access/certs`
                ? LocalResponse.json({ keys: [jwk] })
                : new LocalResponse(null, { status: 502 }),
            );
          },
        },
      },
    };
  }
  const runtime = new Miniflare({
    workers: [
      worker("application", "synthetic-app-secret-at-least-32-characters"),
      worker("invalid-application", "secret-must-not-leak"),
      worker("production", "synthetic-app-secret-at-least-32-characters", {
        WEB_ORIGIN: "https://mytuums.com",
        STREAM_NAMESPACE: "mytuums-production",
        ACCESS_MODE: "public",
      }),
      worker("invalid-public-candidate", "synthetic-app-secret-at-least-32-characters", {
        WEB_ORIGIN: "https://preview-candidate.mytuums.com",
        STREAM_NAMESPACE: "mytuums-production",
        ACCESS_MODE: "public",
      }),
      {
        config: {
          type: "worker",
          name: "providers",
          compatibilityDate: config.compatibility_date,
          manifest: {
            mainModule: "index.js",
            modules: {
              "index.js": {
                type: "esm",
                contents: `
        import { WorkerEntrypoint } from "cloudflare:workers";
        export default class extends WorkerEntrypoint {
          async send(email) {
            await this.env.DB.prepare("insert into captured_email (sender, recipient, body) values (?, ?, ?)")
              .bind(email.from, email.to, email.text).run();
          }
        }
      `,
              },
            },
          },
          env: { DB: { type: "d1", id: "application_entry_test" } },
        },
      },
    ],
  });
  try {
    const binding = await runtime.getD1Database("DB", "application");
    await runMigrations(
      createDatabase(binding),
      resolve(directory, "../../packages/db/drizzle-d1"),
    );
    await binding.exec("create table captured_email (sender text, recipient text, body text)");
    const production = await runtime.getWorker("production");
    const edgeHeaders = { "cf-connecting-ip": "203.0.113.28" };
    const publicPage = await production.fetch("https://mytuums.com/login", {
      headers: edgeHeaders,
    });
    expect(publicPage.status).toBe(200);
    expect(publicPage.headers.get("x-robots-tag")).toBeNull();
    expect(await publicPage.text()).toContain("https://mytuums.com/login");
    expect(
      (await production.fetch("https://mytuums.com/", { headers: edgeHeaders, redirect: "manual" }))
        .status,
    ).toBe(302);
    expect(
      (
        await production.fetch("https://mytuums.com/api/auth/admin/list-users", {
          headers: edgeHeaders,
        })
      ).status,
    ).toBe(404);
    expect(
      (await production.fetch("https://preview.mytuums.com/login", { headers: edgeHeaders }))
        .status,
    ).toBe(404);
    const invalidCandidate = await runtime.getWorker("invalid-public-candidate");
    expect(
      (
        await invalidCandidate.fetch("https://preview-candidate.mytuums.com/login", {
          headers: edgeHeaders,
        })
      ).status,
    ).toBe(503);
    const headers = { "cf-access-jwt-assertion": token, "cf-connecting-ip": "203.0.113.28" };
    for (const path of [
      "/login",
      "/index.html",
      "/mytuums-192.png",
      "/health",
      "/api/auth/get-session",
    ])
      expect((await runtime.dispatchFetch(`${origin}${path}`)).status).toBe(404);
    expect(
      (await runtime.dispatchFetch("https://alternative.workers.dev/login", { headers })).status,
    ).toBe(404);
    expect((await runtime.dispatchFetch(`${origin}/health`, { headers })).status).toBe(200);
    const page = await runtime.dispatchFetch(`${origin}/login`, { headers });
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("private, no-store");
    expect(page.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(page.headers.get("content-security-policy")).toContain("https://*.videodelivery.net");
    const html = await page.text();
    expect(html).toContain(`${origin}/login`);
    expect(html).not.toContain("https://mytuums.com");
    const script = /<script[^>]+src="([^"]+)"/.exec(html)?.[1];
    if (!script) throw new Error("Missing built application script.");
    expect((await runtime.dispatchFetch(new URL(script, origin))).status).toBe(404);
    const javascript = await runtime.dispatchFetch(new URL(script, origin), { headers });
    expect(javascript.status).toBe(200);
    await javascript.body?.cancel();
    // The provider module can be emitted into a lazy chunk, not the HTML entry.
    const assetDirectory = resolve(directory, config.assets.directory, "assets");
    const scripts = await Promise.all(
      (await readdir(assetDirectory))
        .filter((name) => name.endsWith(".js"))
        .map((name) => readFile(resolve(assetDirectory, name), "utf8")),
    );
    expect(scripts.some((source) => source.includes("google,discord,twitch"))).toBe(true);
    const robots = await runtime.dispatchFetch(`${origin}/robots.txt`, { headers });
    expect(await robots.text()).toContain("Disallow: /");
    const image = await runtime.dispatchFetch(`${origin}/mytuums-192.png`, { headers });
    expect(image.status).toBe(200);
    await image.body?.cancel();
    for (const path of ["/assets/absent.js", "/api/auth/admin/ban-user", "/rpc/absent"])
      expect((await runtime.dispatchFetch(`${origin}${path}`, { headers })).status).toBe(404);
    const credentials = {
      email: "nativeentry@example.com",
      password: "Synthetic-entry-passphrase-123!",
    };
    const authHeaders = { ...headers, origin, "content-type": "application/json" };
    const signup = await runtime.dispatchFetch(`${origin}/api/auth/sign-up/email`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        ...credentials,
        name: "Entry",
        username: "nativeentry",
        dateOfBirth: "2000-01-01",
        legalAcceptedAt: new Date().toISOString(),
        legalVersion: LEGAL_VERSION,
      }),
    });
    expect(signup.status, await signup.clone().text()).toBe(200);
    const email = await binding
      .prepare("select * from captured_email")
      .first<{ sender: string; recipient: string; body: string }>();
    expect(email?.sender).toBe(config.vars.EMAIL_FROM);
    expect(email?.recipient).toBe(credentials.email);
    expect(email?.body).toContain(`${origin}/api/auth/verify-email`);
    await binding
      .prepare("update user set email_verified = 1 where email = ?")
      .bind(credentials.email)
      .run();
    const signin = await runtime.dispatchFetch(`${origin}/api/auth/sign-in/email`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify(credentials),
    });
    expect(signin.status, await signin.clone().text()).toBe(200);
    const cookie = signin.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    expect(cookie).toContain("__Secure-better-auth.session_token=");
    expect(cookie).not.toContain("Domain=mytuums.com");
    const session = await runtime.dispatchFetch(`${origin}/api/auth/get-session`, {
      headers: { ...headers, cookie },
    });
    expect(
      z.object({ user: z.object({ email: z.string() }) }).parse(await session.json()).user.email,
    ).toBe(credentials.email);
    const client: RouterClient<AppRouter> = createORPCClient(
      new RPCLink({
        url: `${origin}/rpc`,
        plugins: [new SimpleCsrfProtectionLinkPlugin()],
        async fetch(request) {
          const rpcHeaders = new Headers(request.headers);
          for (const [name, value] of Object.entries(headers)) rpcHeaders.set(name, value);
          rpcHeaders.set("origin", origin);
          rpcHeaders.set("cookie", cookie);
          const response = await runtime.dispatchFetch(request.url, {
            method: request.method,
            headers: Object.fromEntries(rpcHeaders),
            body: request.body ? new Uint8Array(await request.arrayBuffer()) : undefined,
          });
          return new Response(await response.arrayBuffer(), {
            status: response.status,
            headers: Object.fromEntries(response.headers),
          });
        },
      }),
    );
    expect(await client.post.linkCard({ url: "https://public-preview.example.test/" })).toEqual({
      card: null,
    });
    expect(await client.post.linkCard({ url: "http://127.0.0.1/private" })).toEqual({ card: null });
    for (const [provider, hostname] of [
      ["google", "accounts.google.com"],
      ["discord", "discord.com"],
      ["twitch", "id.twitch.tv"],
    ]) {
      const social = await runtime.dispatchFetch(`${origin}/api/auth/sign-in/social`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ provider, callbackURL: `${origin}/`, disableRedirect: true }),
      });
      expect(social.status, await social.clone().text()).toBe(200);
      const result = z.object({ url: z.url() }).parse(await social.json());
      expect(new URL(result.url).hostname).toBe(hostname);
      expect(new URL(result.url).searchParams.get("redirect_uri")).toBe(
        `${origin}/api/auth/callback/${provider}`,
      );
    }
    const invalid = await (await runtime.getWorker("invalid-application")).fetch(`${origin}/login`);
    expect(invalid.status).toBe(503);
    expect(await invalid.text()).toBe("Service unavailable");
    expect(invalid.headers.get("cache-control")).toBe("private, no-store");
    expect(new Set(externalRequests)).toEqual(new Set([`${issuer}/cdn-cgi/access/certs`]));
  } finally {
    await runtime.dispose();
  }
}, 30_000);
