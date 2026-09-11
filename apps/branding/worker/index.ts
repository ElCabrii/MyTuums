import { createAccessVerifier } from "../../server/src/access.js";

function createHandler(env: BrandingEnv) {
  const authorizeAccess = createAccessVerifier({
    teamDomain: env.ACCESS_TEAM_DOMAIN,
    audience: env.ACCESS_AUDIENCE,
  });
  return async (request: Request): Promise<Response> => {
    const requestId = crypto.randomUUID();
    let response: Response;
    try {
      const url = new URL(request.url);
      if (url.origin !== env.BRANDING_ORIGIN || !(await authorizeAccess(request))) {
        response = new Response("Not found", { status: 404 });
      } else if (request.method !== "GET" && request.method !== "HEAD") {
        response = new Response("Method not allowed", {
          status: 405,
          headers: { Allow: "GET, HEAD" },
        });
      } else {
        // This site has one page. An unknown path or missing asset must stay 404.
        if (url.pathname === "/") url.pathname = "/index.html";
        response = await env.ASSETS.fetch(new Request(url, request));
      }
    } catch {
      console.error({ event: "branding_request_failed", requestId });
      response = new Response("Service unavailable", { status: 503 });
    } finally {
      if (request.body && !request.body.locked) request.body.cancel().catch(() => {});
    }
    const headers = new Headers(response.headers);
    headers.set("cache-control", "private, no-store");
    headers.set("x-request-id", requestId);
    headers.set("x-robots-tag", "noindex, nofollow");
    headers.set("x-content-type-options", "nosniff");
    headers.set("x-frame-options", "DENY");
    headers.set("referrer-policy", "strict-origin-when-cross-origin");
    headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
    headers.set(
      "content-security-policy",
      [
        "default-src 'self'",
        "base-uri 'self'",
        "object-src 'none'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self'",
        "font-src 'self'",
        "connect-src 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join("; "),
    );
    if (request.method === "HEAD") {
      await response.body?.cancel().catch(() => {});
      return new Response(null, { status: response.status, headers });
    }
    return new Response(response.body, { status: response.status, headers });
  };
}

let handle: ReturnType<typeof createHandler> | undefined;
export default {
  fetch(request: Request, env: BrandingEnv): Promise<Response> {
    handle ??= createHandler(env);
    return handle(request);
  },
};
