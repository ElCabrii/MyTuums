import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Miniflare, Response as LocalResponse } from "miniflare";
import { unstable_readConfig as readConfig } from "wrangler";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { expect, it } from "vitest";
import { z } from "zod";

it("serves the built branding site only after Access, including real static asset routing", async () => {
  // Build @my-tuums/branding first: use the actual Wrangler artifact and Vite assets.
  const directory = fileURLToPath(new URL("../../branding/", import.meta.url));
  const config = z
    .object({
      compatibility_date: z.string(),
      compatibility_flags: z.array(z.string()),
      assets: z.object({
        directory: z.string(),
        binding: z.literal("ASSETS"),
        run_worker_first: z.literal(true),
        html_handling: z.literal("none"),
        not_found_handling: z.literal("none"),
      }),
      vars: z.object({
        BRANDING_ORIGIN: z.url(),
        ACCESS_TEAM_DOMAIN: z.url(),
        ACCESS_AUDIENCE: z.string(),
      }),
    })
    .parse(readConfig({ config: resolve(directory, "wrangler.jsonc") }));
  const vars = config.vars;
  const key = await generateKeyPair("RS256");
  const jwk = {
    ...(await exportJWK(key.publicKey)),
    kid: "synthetic-branding-key",
    alg: "RS256",
    use: "sig",
  };
  const token = await new SignJWT({
    iss: vars.ACCESS_TEAM_DOMAIN,
    aud: [vars.ACCESS_AUDIENCE],
    exp: Math.floor(Date.now() / 1000) + 3600,
  })
    .setProtectedHeader({ alg: "RS256", kid: jwk.kid })
    .sign(key.privateKey);
  const bundle = await readFile(resolve(directory, ".wrangler/dist/index.js"), "utf8");
  const runtime = new Miniflare({
    workers: ["private", "public", "private-with-public-flag"].map((mode) => ({
      config: {
        type: "worker",
        name: `branding-${mode}-test`,
        compatibilityDate: config.compatibility_date,
        compatibilityFlags: config.compatibility_flags,
        manifest: {
          mainModule: "index.js",
          modules: {
            "index.js": {
              type: "esm",
              contents: bundle,
            },
          },
        },
        env: {
          ASSETS: { type: "assets" },
          BRANDING_ORIGIN: {
            type: "json",
            value: mode === "public" ? "https://about.mytuums.com" : vars.BRANDING_ORIGIN,
          },
          ACCESS_MODE: { type: "json", value: mode === "private" ? "required" : "public" },
          ACCESS_TEAM_DOMAIN: { type: "json", value: vars.ACCESS_TEAM_DOMAIN },
          ACCESS_AUDIENCE: { type: "json", value: vars.ACCESS_AUDIENCE },
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
            return Promise.resolve(
              request.url === `${vars.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`
                ? LocalResponse.json({ keys: [jwk] })
                : new LocalResponse(null, { status: 502 }),
            );
          },
        },
      },
    })),
  });
  try {
    const production = await runtime.getWorker("branding-public-test");
    const publicOrigin = "https://about.mytuums.com";
    const publicPage = await production.fetch(publicOrigin);
    expect(publicPage.status).toBe(200);
    expect(publicPage.headers.get("x-robots-tag")).toBeNull();
    expect(publicPage.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect((await production.fetch(`${publicOrigin}/mytuums.svg`)).status).toBe(200);
    expect((await production.fetch(`${publicOrigin}/unknown`)).status).toBe(404);
    expect((await production.fetch(vars.BRANDING_ORIGIN)).status).toBe(404);
    expect((await production.fetch(publicOrigin, { method: "POST", body: "ignored" })).status).toBe(
      405,
    );
    const productionHead = await production.fetch(publicOrigin, { method: "HEAD" });
    expect(productionHead.status).toBe(200);
    expect(await productionHead.text()).toBe("");
    const privateWithFlag = await runtime.getWorker("branding-private-with-public-flag-test");
    expect((await privateWithFlag.fetch(vars.BRANDING_ORIGIN)).status).toBe(404);
    const origin = vars.BRANDING_ORIGIN;
    const headers = { "cf-access-jwt-assertion": token };
    for (const path of ["/", "/index.html", "/mytuums.svg", "/robots.txt"])
      expect((await runtime.dispatchFetch(`${origin}${path}`)).status).toBe(404);
    expect(
      (await runtime.dispatchFetch("https://alternative.workers.dev/", { headers })).status,
    ).toBe(404);
    const page = await runtime.dispatchFetch(origin, { headers });
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("private, no-store");
    expect(page.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(page.headers.get("x-request-id")).toMatch(/^[a-f0-9-]{36}$/);
    const html = await page.text();
    expect(html).toContain(`href="${origin}/"`);
    expect(html).toContain('"url": "https://cf-poc.mytuums.com"');
    expect(html).not.toContain("https://about.mytuums.com");
    const script = /<script[^>]+src="([^"]+)"/.exec(html)?.[1];
    if (!script) throw new Error("Missing built branding script.");
    expect((await runtime.dispatchFetch(new URL(script, origin))).status).toBe(404);
    const javascript = await runtime.dispatchFetch(new URL(script, origin), { headers });
    expect(javascript.status).toBe(200);
    expect(await javascript.text()).toContain("https://cf-poc.mytuums.com");
    const head = await runtime.dispatchFetch(origin, { method: "HEAD", headers });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const robots = await runtime.dispatchFetch(`${origin}/robots.txt`, { headers });
    expect(await robots.text()).toContain("Disallow: /");
    for (const path of ["/unknown", "/api/auth/get-session", "/rpc/me", "/assets/missing.js"])
      expect((await runtime.dispatchFetch(`${origin}${path}`, { headers })).status).toBe(404);
    expect(
      (await runtime.dispatchFetch(origin, { method: "POST", headers, body: "ignored" })).status,
    ).toBe(405);
  } finally {
    await runtime.dispose();
  }
}, 30_000);
