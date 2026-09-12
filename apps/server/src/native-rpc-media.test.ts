import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "tsup";
import { Miniflare, Response as LocalResponse } from "miniflare";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import sharp from "sharp";
import { expect, it } from "vitest";
import { z } from "zod";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { SimpleCsrfProtectionLinkPlugin } from "@orpc/client/plugins";
import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "@my-tuums/api/cloudflare-app";
import { createDatabase } from "@my-tuums/db";
import { runMigrations } from "@my-tuums/db/migrate";
import { LEGAL_VERSION } from "@my-tuums/auth/rules";

it("runs real multipart RPC uploads, D1 visibility, R2 delivery and cleanup in workerd", async () => {
  const path = await mkdtemp(join(tmpdir(), "mytuums-rpc-media-test-"));
  let runtime: Miniflare | undefined;
  try {
    const issuer = "https://synthetic-team.cloudflareaccess.com";
    const key = await generateKeyPair("RS256");
    const jwk = {
      ...(await exportJWK(key.publicKey)),
      kid: "synthetic-key",
      alg: "RS256",
      use: "sig",
    };
    const token = await new SignJWT({
      iss: issuer,
      aud: ["a".repeat(64)],
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
      .setProtectedHeader({ alg: "RS256", kid: "synthetic-key" })
      .sign(key.privateKey);
    await build({
      config: false,
      entry: {
        index: fileURLToPath(new URL("../worker/tests/rpc-media-entry.ts", import.meta.url)),
      },
      platform: "neutral",
      target: "es2022",
      format: ["esm"],
      bundle: true,
      splitting: false,
      noExternal: [/^(?!cloudflare:|node:)/],
      external: [/^node:/, /^cloudflare:/],
      esbuildOptions(options) {
        options.conditions = ["workerd", "worker", "browser"];
      },
      outDir: path,
      silent: true,
      metafile: true,
    });
    const bundle = z
      .object({
        outputs: z.record(
          z.string(),
          z.object({ inputs: z.record(z.string(), z.object({ bytesInOutput: z.number() })) }),
        ),
      })
      .parse(JSON.parse(await readFile(join(path, "metafile-esm.json"), "utf8")));
    const shipped = Object.values(bundle.outputs).flatMap((output) =>
      Object.entries(output.inputs)
        .filter(([, input]) => input.bytesInOutput > 0)
        .map(([name]) => name),
    );
    expect(
      shipped.filter((name) => /node_modules\/(?:@aws-sdk|sharp|undici)\//.test(name)),
    ).toEqual([]);
    runtime = new Miniflare({
      workers: [
        {
          config: {
            type: "worker",
            name: "rpc-media-test",
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
            exports: {
              RateLimitCounter: { type: "durable-object", storage: "sqlite" },
              AuthRateLimitCounter: { type: "durable-object", storage: "sqlite" },
            },
            env: {
              DB: { type: "d1", id: "rpc_media_test" },
              MEDIA: { type: "r2", name: "rpc-media-test", jurisdiction: "eu" },
              IMAGES: { type: "images", dev: { remote: false } },
              API_COUNTERS: {
                type: "durable-object",
                worker: "rpc-media-test",
                exportName: "RateLimitCounter",
              },
              AUTH_COUNTERS: {
                type: "durable-object",
                worker: "rpc-media-test",
                exportName: "AuthRateLimitCounter",
              },
            },
          },
          dev: {
            outboundService: {
              type: "fetcher",
              handler(request) {
                return Promise.resolve(
                  request.url === `${issuer}/cdn-cgi/access/certs`
                    ? LocalResponse.json({ keys: [jwk] })
                    : new LocalResponse(null, { status: 502 }),
                );
              },
            },
          },
        },
      ],
    });
    const binding = await runtime.getD1Database("DB", "rpc-media-test");
    await runMigrations(
      createDatabase(binding),
      fileURLToPath(new URL("../../../packages/db/drizzle-d1", import.meta.url)),
    );
    const bucket = await runtime.getR2Bucket("MEDIA", "rpc-media-test");
    const rawDispatch = runtime.dispatchFetch;
    const edgeHeaders = { "cf-access-jwt-assertion": token, "cf-connecting-ip": "203.0.113.20" };
    const dispatch = (url: string, init: Parameters<typeof rawDispatch>[1] = {}) =>
      rawDispatch(url, {
        ...init,
        headers: { ...edgeHeaders, ...Object.fromEntries(new Headers(init.headers)) },
      });
    const origin = "https://rpc-poc.example.test";
    expect((await rawDispatch(`${origin}/login`)).status).toBe(404);
    expect((await dispatch("https://alternate.workers.dev/login")).status).toBe(404);
    const shell = await dispatch(`${origin}/login`);
    expect(shell.status).toBe(200);
    expect(await shell.text()).toContain(`${origin}/login`);
    expect(shell.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect((await dispatch(`${origin}/assets/missing.js`)).status).toBe(404);
    expect((await dispatch(`${origin}/api/auth/admin/ban-user`)).status).toBe(404);
    expect((await dispatch(`${origin}/health`)).status).toBe(200);
    async function signIn(name: string) {
      const credentials = {
        email: `${name}@example.com`,
        password: `Synthetic-${name}-passphrase-123!`,
      };
      const headers = {
        origin,
        "content-type": "application/json",
        "x-mytuums-client-ip": "203.0.113.20",
      };
      const signup = await dispatch(`${origin}/api/auth/sign-up/email`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          ...credentials,
          name,
          username: name,
          dateOfBirth: "2000-01-01",
          legalAcceptedAt: new Date().toISOString(),
          legalVersion: LEGAL_VERSION,
        }),
      });
      expect(signup.status, await signup.clone().text()).toBe(200);
      // Verification delivery has its own native test; this fixture needs two real sessions.
      await binding
        .prepare("update user set email_verified = 1 where email = ?")
        .bind(credentials.email)
        .run();
      const response = await dispatch(`${origin}/api/auth/sign-in/email`, {
        method: "POST",
        headers,
        body: JSON.stringify(credentials),
      });
      expect(response.status, await response.clone().text()).toBe(200);
      return response.headers
        .getSetCookie()
        .map((cookie) => cookie.split(";")[0])
        .join("; ");
    }
    const ownerCookie = await signIn("nativeowner");
    const viewerCookie = await signIn("nativeviewer");
    const observation = z.object({ status: z.number(), pulls: z.number(), cancelled: z.boolean() });
    const { admission, oversized } = z
      .object({ admission: z.array(observation), oversized: observation })
      .parse(await (await dispatch(`${origin}/probe-auth`)).json());
    expect(admission.slice(0, 10).map((result) => result.status)).toEqual(
      Array.from({ length: 10 }, () => 400),
    );
    expect(admission[10]).toEqual({ status: 429, pulls: 0, cancelled: true });
    expect(oversized).toEqual({ status: 413, pulls: 9, cancelled: true });
    const tooLarge = await dispatch(`${origin}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ padding: "x".repeat(1024 * 1024) }),
    });
    expect(tooLarge.status).toBe(413);
    function client(cookie: string) {
      return createORPCClient<RouterClient<AppRouter>>(
        new RPCLink({
          url: `${origin}/rpc`,
          plugins: [new SimpleCsrfProtectionLinkPlugin()],
          async fetch(request) {
            const headers = new Headers(request.headers);
            headers.set("origin", origin);
            headers.set("cookie", cookie);
            headers.set("x-mytuums-client-ip", "203.0.113.20");
            const response = await dispatch(request.url, {
              method: request.method,
              headers: Object.fromEntries(headers),
              body: request.body ? new Uint8Array(await request.arrayBuffer()) : undefined,
            });
            return new Response(await response.arrayBuffer(), {
              status: response.status,
              headers: Object.fromEntries(response.headers),
            });
          },
        }),
      );
    }
    const owner = client(ownerCookie);
    const viewer = client(viewerCookie);
    await expect(client("").me()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    const csrfRefusal = await dispatch(`${origin}/rpc/me`, {
      method: "POST",
      headers: { cookie: ownerCookie, "content-type": "application/json" },
      body: "{}",
    });
    expect(csrfRefusal.status).toBe(403);
    const bytes = new Uint8Array(
      await sharp({ create: { width: 192, height: 96, channels: 3, background: "#234567" } })
        .png()
        .toBuffer(),
    );
    const file = () => new File([bytes], "image.png", { type: "image/png" });
    const image = await owner.user.uploadImage({
      kind: "avatar",
      original: file(),
      display: file(),
    });
    expect(image.url).toMatch(/^\/media\/avatars\//);
    const read = (url: string, cookie = "") => dispatch(`${origin}${url}`, { headers: { cookie } });
    expect((await read(image.originalUrl)).status).toBe(404);
    expect((await read(image.originalUrl, viewerCookie)).status).toBe(404);
    expect((await read(image.originalUrl, ownerCookie)).status).toBe(200);
    const display = await read(image.url, viewerCookie);
    expect(display.status).toBe(200);
    expect(display.headers.get("cache-control")).toBe("private, no-store");
    expect(display.headers.get("location")).toBeNull();
    expect(new Uint8Array(await display.arrayBuffer())).toEqual(bytes);
    const thumbnail = await read(`${image.url}.w96.webp`, viewerCookie);
    expect(thumbnail.status).toBe(200);
    expect(await sharp(Buffer.from(await thumbnail.arrayBuffer())).metadata()).toMatchObject({
      width: 96,
      height: 48,
      format: "webp",
    });
    const post = await owner.post.create({
      content: "Private native image",
      isPrivate: true,
      attachments: [file()],
    });
    const postImage = z.object({ attachments: z.array(z.object({ url: z.string() })) }).parse(post)
      .attachments[0].url;
    expect((await read(postImage, viewerCookie)).status).toBe(404);
    expect((await read(postImage, ownerCookie)).status).toBe(200);
    expect((await bucket.list({ prefix: "posts/" })).objects).toHaveLength(1);
    await owner.post.delete({ postId: post.id });
    expect((await read(postImage, ownerCookie)).status).toBe(404);
    expect((await bucket.list({ prefix: "posts/" })).objects).toHaveLength(0);
    await owner.user.removeImage({ kind: "avatar" });
    expect((await read(image.url, viewerCookie)).status).toBe(404);
    expect((await bucket.list({ prefix: "avatars/" })).objects).toHaveLength(0);
    await expect(
      viewer.user.uploadImage({
        kind: "avatar",
        original: new File(["not an image"], "fake.png", { type: "image/png" }),
        display: file(),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await bucket.list()).objects).toHaveLength(0);
  } finally {
    await runtime?.dispose();
    await rm(path, { recursive: true, force: true });
  }
}, 60_000);
