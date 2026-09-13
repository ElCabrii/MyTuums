import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { expect, it } from "vitest";
import { createAccessVerifier } from "./access.js";

const issuer = "https://synthetic-team.cloudflareaccess.com";
const audience = "a".repeat(64);
const key = await generateKeyPair("RS256");
const publicKey = {
  ...(await exportJWK(key.publicKey)),
  kid: "synthetic-key",
  alg: "RS256",
  use: "sig",
};
const now = () => Math.floor(Date.now() / 1000);
function token(claims: JWTPayload = {}, signingKey = key.privateKey) {
  return new SignJWT({
    iss: issuer,
    aud: [audience],
    sub: "synthetic-owner",
    exp: now() + 3600,
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: "synthetic-key" })
    .sign(signingKey);
}
function request(token?: string) {
  return new Request("https://preview.example.test/", {
    headers: token ? { "cf-access-jwt-assertion": token } : {},
  });
}
const keys = () => Promise.resolve(Response.json({ keys: [publicKey] }));

it("accepts a signed application token using only the configured team's signing keys", async () => {
  const urls: string[] = [];
  const verify = createAccessVerifier({
    teamDomain: issuer,
    audience,
    fetch(url, init) {
      urls.push(url);
      expect(init.redirect).toBe("manual");
      expect(init.headers.has("cf-access-jwt-assertion")).toBe(false);
      return keys();
    },
  });
  expect(await verify(request(await token()))).toBe(true);
  expect(urls).toEqual([`${issuer}/cdn-cgi/access/certs`]);
});

it("rejects wrong issuer/audience, expiry, future validity, missing expiry and forged signatures", async () => {
  const verify = createAccessVerifier({ teamDomain: issuer, audience, fetch: keys });
  for (const claims of [
    { iss: "https://other-team.cloudflareaccess.com" },
    { aud: "b".repeat(64) },
    { exp: now() - 1 },
    { nbf: now() + 60 },
    { exp: undefined },
  ])
    expect(await verify(request(await token(claims)))).toBe(false);
  const forged = await generateKeyPair("RS256");
  expect(await verify(request(await token({}, forged.privateKey)))).toBe(false);
  expect(await verify(request("eyJhbGciOiJub25lIn0.e30."))).toBe(false);
  expect(await verify(request())).toBe(false);
  expect(await verify(request("x".repeat(16 * 1024 + 1)))).toBe(false);
});

it("fails closed when signing keys are unavailable, redirected, malformed or too large", async () => {
  for (const response of [
    () => Promise.reject(new Error("synthetic network failure")),
    () =>
      Promise.resolve(
        new Response(null, { status: 302, headers: { Location: "https://example.com" } }),
      ),
    () => Promise.resolve(new Response("not JSON")),
    () => Promise.resolve(new Response("x".repeat(1024 * 1024 + 1))),
  ]) {
    const verify = createAccessVerifier({ teamDomain: issuer, audience, fetch: response });
    expect(await verify(request(await token()))).toBe(false);
  }
});

it("rejects invalid deployment configuration before accepting requests", () => {
  for (const teamDomain of [
    "http://synthetic-team.cloudflareaccess.com",
    "https://example.com",
    `${issuer}/other`,
    `${issuer}?x=1`,
  ])
    expect(() => createAccessVerifier({ teamDomain, audience })).toThrow("configuration");
  expect(() => createAccessVerifier({ teamDomain: issuer, audience: "" })).toThrow("configuration");
});
