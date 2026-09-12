import { describe, expect, it } from "vitest";
import { createLinkFetchHandler, linkFetchRequestSchema } from "./handler.js";
import { createLinkFetchTransport } from "../../../packages/api/src/link-card-node.js";
import {
  guardedLinkFetch,
  type LinkFetchTransport,
} from "../../../packages/api/src/link-card-http.js";
import { createWorkerLinkTransport } from "../../server/worker/link-transport.js";

function bridge(transport: LinkFetchTransport) {
  const handle = createLinkFetchHandler(transport);
  return createWorkerLinkTransport({
    async fetch(request) {
      const input: unknown = await request.json();
      return handle(linkFetchRequestSchema.parse({ path: new URL(request.url).pathname, input }));
    },
  });
}

describe("private link fetch boundary", () => {
  it("carries HTML and redirects across the service without forwarding upstream cookies", async () => {
    const transport = bridge({
      lookup: () => Promise.resolve(["93.184.216.34"]),
      fetch: (url) =>
        Promise.resolve(
          url.pathname === "/start"
            ? new Response(null, {
                status: 302,
                headers: { location: "/page", "set-cookie": "unsafe=1" },
              })
            : new Response("<title>Preserved card</title>", {
                headers: { "content-type": "text/html", "set-cookie": "unsafe=1" },
              }),
        ),
    });
    const hop = await transport.fetch(new URL("https://example.com/start"), {
      signal: new AbortController().signal,
    });
    expect(hop.status).toBe(302);
    expect(hop.headers.get("set-cookie")).toBeNull();
    const result = await guardedLinkFetch(new URL("https://example.com/start"), {
      transport,
      maxBytes: 1024,
      acceptContentType: (t) => t === "text/html",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(new TextDecoder().decode(result.bytes)).toBe("<title>Preserved card</title>");
      expect(result.finalUrl.pathname).toBe("/page");
    }
  });

  it("refuses private addresses at the container boundary even without the Worker preflight", async () => {
    const handle = createLinkFetchHandler(createLinkFetchTransport());
    for (const url of [
      "http://127.0.0.1/",
      "http://169.254.169.254/",
      "http://[::ffff:127.0.0.1]/",
      "file:///etc/passwd",
    ])
      expect((await handle({ path: "/fetch", input: { url } })).status).toBe(502);
  });

  it("keeps a redirect into a private network from reaching the target through the bridge", async () => {
    const targets: string[] = [];
    const transport = bridge({
      lookup: (hostname) =>
        Promise.resolve([hostname === "example.com" ? "93.184.216.34" : "127.0.0.1"]),
      fetch: (url) => {
        targets.push(url.hostname);
        return Promise.resolve(
          new Response(null, { status: 302, headers: { location: "http://private.example/" } }),
        );
      },
    });
    expect(
      await guardedLinkFetch(new URL("https://example.com/"), {
        transport,
        maxBytes: 1024,
        acceptContentType: () => true,
      }),
    ).toEqual({ ok: false, reason: "address" });
    expect(targets).toEqual(["example.com"]);
  });

  it("rejects credential-bearing URLs and caps bytes before returning them to the Worker", async () => {
    const handle = createLinkFetchHandler({
      lookup: () => Promise.resolve(["93.184.216.34"]),
      fetch: () => Promise.resolve(new Response(new Uint8Array(5 * 1024 * 1024 + 1))),
    });
    expect(
      (await handle({ path: "/fetch", input: { url: "https://secret:password@example.com/" } }))
        .status,
    ).toBe(400);
    expect((await handle({ path: "/fetch", input: { url: "https://example.com/" } })).status).toBe(
      502,
    );
  });
});
