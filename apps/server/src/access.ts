import { createRemoteJWKSet, customFetch, jwtVerify, type FetchImplementation } from "jose";

/** Bind a verifier to one Access application, never to claims supplied by a caller. */
export function createAccessVerifier(options: {
  teamDomain: string;
  audience: string;
  fetch?: FetchImplementation;
}) {
  const domain = new URL(options.teamDomain);
  if (
    domain.protocol !== "https:" ||
    domain.username ||
    domain.password ||
    domain.port ||
    domain.pathname !== "/" ||
    domain.search ||
    domain.hash ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/.test(domain.hostname) ||
    !/^[a-f0-9]{64}$/.test(options.audience)
  )
    throw new Error("Invalid Cloudflare Access configuration.");
  const issuer = domain.origin;
  const send: FetchImplementation = options.fetch ?? fetch;
  const keys = createRemoteJWKSet(new URL("/cdn-cgi/access/certs", issuer), {
    timeoutDuration: 5000,
    cooldownDuration: 30_000,
    cacheMaxAge: 600_000,
    async [customFetch](url, init) {
      // JOSE supplies a GET, manual redirects and a deadline signal. Bound the
      // public certificate response too, before its JSON parser allocates it.
      const response = await send(url, init);
      if (response.status !== 200 || !response.body) {
        await response.body?.cancel().catch(() => {});
        throw new Error("Access signing keys are unavailable.");
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
      let size = 0;
      let text = "";
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          const bytes: unknown = chunk.value;
          if (!(bytes instanceof Uint8Array)) throw new Error("Invalid Access signing keys.");
          size += bytes.byteLength;
          if (size > 1024 * 1024) throw new Error("Access signing keys exceed the size limit.");
          text += decoder.decode(bytes, { stream: true });
        }
        text += decoder.decode();
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      return new Response(text, { headers: { "content-type": "application/json" } });
    },
  });
  return async (request: Request): Promise<boolean> => {
    const token = request.headers.get("cf-access-jwt-assertion");
    if (!token || token.length > 16 * 1024) return false;
    try {
      await jwtVerify(token, keys, {
        issuer,
        audience: options.audience,
        algorithms: ["RS256"],
        requiredClaims: ["iss", "aud", "exp"],
      });
      return true;
    } catch {
      // Neither JWT contents nor provider/verification errors enter logs or replies.
      return false;
    }
  };
}
