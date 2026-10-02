import { z } from "zod";

/** Browser-supplied URLs must never turn the sender into an arbitrary HTTP client. */
export const pushEndpoint = z
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.hash &&
      ["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com"].includes(
        url.hostname,
      )
    );
  }, "Unsupported push service.");

export const webPushPublicKey = z.string().regex(/^B[A-Za-z0-9_-]{86}$/);
const privateKeySchema = z.object({
  kty: z.literal("EC"),
  crv: z.literal("P-256"),
  x: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  y: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  d: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function decode(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (char) =>
    char.charCodeAt(0),
  );
}

export interface PushSender {
  publicKey: string;
  send(endpoint: string): Promise<"sent" | "gone" | "retry">;
}

/** RFC 8292 VAPID. Empty pushes carry no user data and need no payload encryption keys. */
export async function createPushSender(
  privateJwk: string,
  contact: string,
  transport: typeof fetch = fetch,
): Promise<PushSender> {
  const jwk = privateKeySchema.parse(JSON.parse(privateJwk));
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const publicKey = encode(new Uint8Array([4, ...decode(jwk.x), ...decode(jwk.y)]));
  const encoder = new TextEncoder();
  return {
    publicKey,
    async send(endpoint) {
      const url = new URL(pushEndpoint.parse(endpoint));
      const header = encode(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
      const claims = encode(
        encoder.encode(
          JSON.stringify({
            aud: url.origin,
            exp: Math.floor(Date.now() / 1000) + 3600,
            sub: contact,
          }),
        ),
      );
      const signingInput = `${header}.${claims}`;
      const signature = await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        encoder.encode(signingInput),
      );
      const response = await transport(url, {
        method: "POST",
        headers: {
          Authorization: `vapid t=${signingInput}.${encode(new Uint8Array(signature))}, k=${publicKey}`,
          TTL: "300",
          Urgency: "normal",
          Topic: "mytuums-inbox",
        },
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      await response.body?.cancel();
      if (response.status === 404 || response.status === 410) return "gone";
      return response.ok ? "sent" : "retry";
    },
  };
}
