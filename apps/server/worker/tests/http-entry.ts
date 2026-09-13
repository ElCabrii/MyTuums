import { createWorkerRequestHandler } from "../../src/worker-request-handler.js";
import { workerResponseHeaders } from "../../src/worker-response-headers.js";
import { createWorkerDocumentTransform } from "../../src/worker-document.js";
import { createAccessVerifier } from "../../src/access.js";

// Synthetic dependencies around the production request boundary. This entrypoint
// is bundled only by its local test and is never a Wrangler deployment target.
let handle: ReturnType<typeof createWorkerRequestHandler> | undefined;
const authorizeAccess = createAccessVerifier({
  teamDomain: "https://synthetic-team.cloudflareaccess.com",
  audience: "a".repeat(64),
});
export default {
  async fetch(request: Request): Promise<Response> {
    const responseHeaders = await workerResponseHeaders({
      streamOrigins: ["https://customer-test.cloudflarestream.com"],
    });
    handle ??= createWorkerRequestHandler({
      origin: "https://preview.example.test",
      authorizeAccess,
      pingDb: () => Promise.resolve(),
      resolveSession: () => Promise.resolve({ kind: "authenticated", userId: "synthetic-viewer" }),
      handleAuth: () => Promise.resolve(new Response("auth")),
      async handleRpc(request) {
        return Response.json({
          bytes: (await request.arrayBuffer()).byteLength,
          ip: request.headers.get("x-mytuums-client-ip"),
        });
      },
      resolveMedia: () => Promise.resolve(null),
      fetchAsset: (request) =>
        Promise.resolve(
          new URL(request.url).pathname === "/index.html"
            ? new Response("<html>synthetic shell</html>", {
                headers: { "content-type": "text/html" },
              })
            : new Response("Not found", { status: 404 }),
        ),
      transformDocument: createWorkerDocumentTransform((path, html) => Promise.resolve(html)),
      responseHeaders,
      observe() {},
    });
    return handle(request);
  },
};
