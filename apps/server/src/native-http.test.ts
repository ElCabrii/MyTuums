import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "tsup";
import { Miniflare, Response as LocalResponse } from "miniflare";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { expect, it } from "vitest";
import { RPC_SMALL_BODY_BYTES } from "@my-tuums/api/constants";

it("runs admission, bounded bodies, private routing and headers in the actual Worker runtime", async () => {
  const path = await mkdtemp(join(tmpdir(), "mytuums-http-test-"));
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
      entry: { index: fileURLToPath(new URL("../worker/tests/http-entry.ts", import.meta.url)) },
      platform: "neutral",
      target: "es2022",
      format: ["esm"],
      bundle: true,
      noExternal: [/.*/],
      outDir: path,
      silent: true,
    });
    runtime = new Miniflare({
      workers: [
        {
          config: {
            type: "worker",
            name: "http-test",
            compatibilityDate: "2026-09-10",
            manifest: {
              mainModule: "index.js",
              modules: {
                "index.js": {
                  type: "esm",
                  contents: await readFile(join(path, "index.js"), "utf8"),
                },
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
    // Exercise HTTP ingress, not the binding proxy, which forwards cancelled
    // upload streams over a separate RPC connection.
    const dispatch = runtime.dispatchFetch;
    const headers = {
      "cf-access-jwt-assertion": token,
      "cf-connecting-ip": "192.0.2.8",
    };
    expect((await dispatch("https://preview.example.test/login")).status).toBe(404);
    const shell = await dispatch("https://preview.example.test/login", { headers });
    expect(await shell.text()).toContain("synthetic shell");
    expect(shell.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(
      (await dispatch("https://preview.example.test/assets/missing.js", { headers })).status,
    ).toBe(404);
    expect(
      (await dispatch("https://preview.example.test/api/auth/admin%2Fban-user", { headers }))
        .status,
    ).toBe(404);
    const largeBody = "x".repeat(RPC_SMALL_BODY_BYTES + 1);
    expect(
      (
        await dispatch("https://preview.example.test/rpc/profile/uploadImage", {
          method: "POST",
          headers,
          body: largeBody,
        })
      ).status,
    ).toBe(401);
    const uploaded = await dispatch("https://preview.example.test/rpc/profile/uploadImage", {
      method: "POST",
      headers: { ...headers, cookie: "__Secure-better-auth.session_token=valid" },
      body: largeBody,
    });
    expect(uploaded.status).toBe(200);
    expect(await uploaded.json()).toMatchObject({
      bytes: RPC_SMALL_BODY_BYTES + 1,
      ip: "192.0.2.8",
    });
  } finally {
    await runtime?.dispose();
    await rm(path, { recursive: true, force: true });
  }
}, 20_000);
