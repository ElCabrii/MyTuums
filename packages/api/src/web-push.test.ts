import { z } from "zod";
import { expect, it } from "vitest";
import { createPushSender } from "./web-push.js";

it("signs a payload-free VAPID request bound to the push origin with a bounded lifetime", async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const requests: Request[] = [];
  const sender = await createPushSender(
    JSON.stringify(jwk),
    "mailto:push@example.com",
    (input, init) => {
      requests.push(new Request(input, init));
      return Promise.resolve(new Response(null, { status: 201 }));
    },
  );
  await expect(sender.send("https://fcm.googleapis.com/fcm/send/token")).resolves.toBe("sent");
  const request = requests[0];
  expect(request.method).toBe("POST");
  expect(request.body).toBeNull();
  expect(request.redirect).toBe("error");
  expect(request.headers.get("TTL")).toBe("300");
  const authorization = request.headers.get("Authorization");
  const match = /^vapid t=([^,]+), k=(.+)$/.exec(authorization ?? "");
  if (!match) throw new Error("Missing VAPID authorization");
  expect(match[2]).toBe(sender.publicKey);
  const [header, payload, signature] = match[1].split(".");
  expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
    typ: "JWT",
    alg: "ES256",
  });
  const claims = z
    .object({ aud: z.string(), exp: z.number(), sub: z.string() })
    .parse(JSON.parse(Buffer.from(payload, "base64url").toString()));
  expect(claims.aud).toBe("https://fcm.googleapis.com");
  expect(claims.sub).toBe("mailto:push@example.com");
  expect(claims.exp).toBeGreaterThan(Date.now() / 1000);
  expect(claims.exp).toBeLessThan(Date.now() / 1000 + 86400);
  await expect(
    crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      pair.publicKey,
      Buffer.from(signature, "base64url"),
      new TextEncoder().encode(`${header}.${payload}`),
    ),
  ).resolves.toBe(true);
  await expect(sender.send("https://127.0.0.1/internal")).rejects.toThrow();
  expect(requests).toHaveLength(1);
});

it.each([
  [410, "gone"],
  [404, "gone"],
  [429, "retry"],
  [500, "retry"],
  [403, "retry"],
] as const)("maps push service status %s to %s", async (status, expected) => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const sender = await createPushSender(
    JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey)),
    "mailto:push@example.com",
    () => Promise.resolve(new Response(null, { status })),
  );
  await expect(sender.send("https://web.push.apple.com/token")).resolves.toBe(expected);
});
