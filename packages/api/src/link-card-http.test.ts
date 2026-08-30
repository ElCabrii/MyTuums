import { describe, expect, it } from "vitest";
import {
  guardedLinkFetch,
  isGlobalUnicastAddress,
  parseOpenGraphMetadata,
  type LinkFetchTransport,
} from "./link-card-http.js";

// ---------------------------------------------------------------------------
// isGlobalUnicastAddress — the SSRF address guard's core
// ---------------------------------------------------------------------------

describe("isGlobalUnicastAddress", () => {
  it.each([
    "93.184.216.34",
    "1.1.1.1",
    "172.32.0.1", // one octet past the private 172.16/12 block
    "192.169.0.1", // one octet past the private 192.168/16 block
  ])("accepts the global address %s", (address) => {
    expect(isGlobalUnicastAddress(address)).toBe(true);
  });

  it.each([
    ["127.0.0.1", "loopback"],
    ["127.8.8.8", "any loopback octet, not just .1"],
    ["10.0.0.1", "RFC 1918 10/8"],
    ["172.16.0.1", "RFC 1918 172.16/12 start"],
    ["172.31.255.255", "RFC 1918 172.16/12 end"],
    ["192.168.1.1", "RFC 1918 192.168/16"],
    ["169.254.169.254", "link-local, the cloud metadata address"],
    ["0.0.0.0", "this-network"],
    ["100.64.0.1", "CGNAT shared"],
    ["192.0.2.1", "TEST-NET-1 documentation"],
    ["198.51.100.7", "TEST-NET-2 documentation"],
    ["203.0.113.9", "TEST-NET-3 documentation"],
    ["198.18.0.5", "benchmarking"],
    ["224.0.0.1", "multicast"],
    ["240.0.0.1", "reserved"],
    ["255.255.255.255", "broadcast"],
  ])("refuses the %s (%s)", (address) => {
    expect(isGlobalUnicastAddress(address)).toBe(false);
  });

  it.each([
    ["2606:2800:220:1:248:1893:25c8:1946", "a real global address"],
    ["2a00:1450:4001:81b::200e", "compressed global address"],
  ])("accepts the global IPv6 address %s (%s)", (address) => {
    expect(isGlobalUnicastAddress(address)).toBe(true);
  });

  it.each([
    ["::1", "IPv6 loopback"],
    ["::", "unspecified"],
    ["fe80::1", "link-local"],
    ["fc00::1", "unique local, start of fc00::/7"],
    ["fd12:3456:789a::1", "unique local, inside fd00::/8"],
    ["ff02::1", "multicast"],
    ["2001:db8::1", "documentation"],
    ["::ffff:127.0.0.1", "IPv4-mapped loopback — judged by the IPv4 it lands on"],
    ["::ffff:192.168.0.1", "IPv4-mapped private"],
    ["64:ff9b::127.0.0.1", "NAT64 into loopback"],
    ["100::", "discard-only"],
  ])("refuses the IPv6 address %s (%s)", (address) => {
    expect(isGlobalUnicastAddress(address)).toBe(false);
  });

  it("refuses anything that is not an address", () => {
    expect(isGlobalUnicastAddress("example.com")).toBe(false);
    expect(isGlobalUnicastAddress("")).toBe(false);
    expect(isGlobalUnicastAddress("999.1.1.1")).toBe(false);
    expect(isGlobalUnicastAddress("fe80::1%eth0")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// guardedLinkFetch — scheme, address, redirect, size, time and type rules
// ---------------------------------------------------------------------------

/**
 * A transport that answers from a script: hostname → responses in order. The
 * lookup answers with a public IP unless a test says otherwise, so the guard's
 * address logic runs for real on every hop.
 */
function scriptableTransport(options: {
  addresses?: string[];
  responses?: (url: URL) => Response | undefined;
  hang?: boolean;
}): LinkFetchTransport & { requests: URL[] } {
  const requests: URL[] = [];
  return {
    requests,
    lookup: () => {
      if (options.addresses) return Promise.resolve(options.addresses);
      return Promise.reject(new Error("NXDOMAIN"));
    },
    fetch: (url, init) => {
      if (options.hang) {
        return new Promise<Response>((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
      requests.push(url);
      const response = options.responses?.(url);
      if (!response) return Promise.reject(new Error("no scripted response"));
      return Promise.resolve(response);
    },
  };
}

const GLOBAL = ["93.184.216.34"];

describe("guardedLinkFetch", () => {
  it("refuses non-http(s) schemes before any request is made", async () => {
    const transport = scriptableTransport({ addresses: GLOBAL });
    const result = await guardedLinkFetch(new URL("file:///etc/passwd"), {
      transport,
      maxBytes: 1024,
      acceptContentType: () => true,
    });
    expect(result).toEqual({ ok: false, reason: "scheme" });
    expect(transport.requests).toHaveLength(0);
  });

  it("refuses a hostname that resolves to a private address", async () => {
    const transport = scriptableTransport({ addresses: ["10.0.0.8"] });
    const result = await guardedLinkFetch(new URL("https://localtest.me/probe"), {
      transport,
      maxBytes: 1024,
      acceptContentType: () => true,
    });
    expect(result).toEqual({ ok: false, reason: "address" });
    expect(transport.requests).toHaveLength(0);
  });

  it("refuses when any one resolved address is private", async () => {
    const transport = scriptableTransport({ addresses: ["93.184.216.34", "127.0.0.1"] });
    const result = await guardedLinkFetch(new URL("https://rebind.example/x"), {
      transport,
      maxBytes: 1024,
      acceptContentType: () => true,
    });
    expect(result).toEqual({ ok: false, reason: "address" });
  });

  it("refuses a hostname that does not resolve", async () => {
    const transport = scriptableTransport({ addresses: undefined });
    const result = await guardedLinkFetch(new URL("https://nx.example.invalid/"), {
      transport,
      maxBytes: 1024,
      acceptContentType: () => true,
    });
    expect(result).toEqual({ ok: false, reason: "address" });
  });

  it("follows a bounded redirect and re-checks the target of every hop", async () => {
    const transport = scriptableTransport({
      addresses: GLOBAL,
      responses: (url) => {
        if (url.pathname === "/hop1")
          return new Response(null, { status: 302, headers: { location: "/hop2" } });
        if (url.pathname === "/hop2")
          return new Response("<html></html>", { headers: { "content-type": "text/html" } });
        return undefined;
      },
    });

    const result = await guardedLinkFetch(new URL("https://example.com/hop1"), {
      transport,
      maxBytes: 1024,
      acceptContentType: () => true,
    });

    expect(result).toMatchObject({ ok: true, finalUrl: new URL("https://example.com/hop2") });
    expect(transport.requests.map((url) => url.pathname)).toEqual(["/hop1", "/hop2"]);
  });

  it("refuses a redirect whose target is a private address", async () => {
    // The first hop resolves globally; the redirect target resolves to the
    // link-local metadata address. The guard must refuse at the hop, before
    // any request to it.
    let lookupCount = 0;
    const transport: LinkFetchTransport & { requests: URL[] } = {
      requests: [],
      lookup: () => {
        lookupCount += 1;
        return Promise.resolve(lookupCount === 1 ? GLOBAL : ["169.254.169.254"]);
      },
      fetch: (url) => {
        transport.requests.push(url);
        if (url.pathname === "/start") {
          return Promise.resolve(
            new Response(null, {
              status: 301,
              headers: { location: "http://169.254.169.254/latest/meta-data" },
            }),
          );
        }
        return Promise.reject(new Error("must not be reached"));
      },
    };

    const result = await guardedLinkFetch(new URL("https://example.com/start"), {
      transport,
      maxBytes: 1024,
      acceptContentType: () => true,
    });

    expect(result).toEqual({ ok: false, reason: "address" });
    expect(transport.requests).toHaveLength(1);
  });

  it("refuses a redirect to a non-http scheme", async () => {
    const transport = scriptableTransport({
      addresses: GLOBAL,
      responses: (url) =>
        url.pathname === "/start"
          ? new Response(null, { status: 302, headers: { location: "file:///etc/passwd" } })
          : undefined,
    });

    const result = await guardedLinkFetch(new URL("https://example.com/start"), {
      transport,
      maxBytes: 1024,
      acceptContentType: () => true,
    });

    expect(result).toEqual({ ok: false, reason: "scheme" });
  });

  it("refuses a redirect chain longer than the bound", async () => {
    const transport = scriptableTransport({
      addresses: GLOBAL,
      responses: (url) => {
        const hop = Number(url.pathname.slice(1));
        return new Response(null, { status: 302, headers: { location: `/${hop + 1}` } });
      },
    });

    const result = await guardedLinkFetch(new URL("https://example.com/1"), {
      transport,
      maxBytes: 1024,
      acceptContentType: () => true,
    });

    expect(result).toEqual({ ok: false, reason: "redirects" });
    // 1 original request + at most LINK_CARD_MAX_REDIRECTS followed.
    expect(transport.requests).toHaveLength(5);
  });

  it("refuses a body larger than the cap without reading it to the end", async () => {
    const transport = scriptableTransport({
      addresses: GLOBAL,
      responses: () => new Response("x".repeat(2048), { headers: { "content-type": "text/html" } }),
    });

    const result = await guardedLinkFetch(new URL("https://example.com/big"), {
      transport,
      maxBytes: 512,
      acceptContentType: () => true,
    });

    expect(result).toEqual({ ok: false, reason: "oversized" });
  });

  it("refuses a target that does not answer in time", async () => {
    const transport = scriptableTransport({ addresses: GLOBAL, hang: true });

    const result = await guardedLinkFetch(new URL("https://slow.example/"), {
      transport,
      timeoutMs: 50,
      maxBytes: 1024,
      acceptContentType: () => true,
    });

    expect(result).toEqual({ ok: false, reason: "timeout" });
  });

  it("refuses a non-HTML content type before reading the body", async () => {
    const transport = scriptableTransport({
      addresses: GLOBAL,
      responses: () => new Response("{}", { headers: { "content-type": "application/json" } }),
    });

    const result = await guardedLinkFetch(new URL("https://example.com/api"), {
      transport,
      maxBytes: 1024,
      acceptContentType: (contentType) => contentType === "text/html",
    });

    expect(result).toEqual({ ok: false, reason: "contentType" });
  });

  it("refuses a non-2xx final status", async () => {
    const transport = scriptableTransport({
      addresses: GLOBAL,
      responses: () =>
        new Response("gone", { status: 404, headers: { "content-type": "text/html" } }),
    });

    const result = await guardedLinkFetch(new URL("https://example.com/missing"), {
      transport,
      maxBytes: 1024,
      acceptContentType: () => true,
    });

    expect(result).toEqual({ ok: false, reason: "status" });
  });

  it("returns the bytes, the normalized content type and the final URL on success", async () => {
    const transport = scriptableTransport({
      addresses: GLOBAL,
      responses: () =>
        new Response("<html>ok</html>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    });

    const result = await guardedLinkFetch(new URL("https://example.com/page"), {
      transport,
      maxBytes: 1024,
      acceptContentType: () => true,
    });

    expect(result).toMatchObject({
      ok: true,
      contentType: "text/html",
      finalUrl: new URL("https://example.com/page"),
    });
    expect(result.ok && new TextDecoder().decode(result.bytes)).toBe("<html>ok</html>");
  });
});

// ---------------------------------------------------------------------------
// parseOpenGraphMetadata
// ---------------------------------------------------------------------------

describe("parseOpenGraphMetadata", () => {
  const base = new URL("https://example.com/articles/1");

  it("extracts the Open Graph fields, resolving a relative image against the page", () => {
    const html = `
      <html><head>
        <meta charset="utf-8">
        <meta property="og:site_name" content="Example Weekly">
        <meta property="og:title" content="A &amp; very good &#39;article&#39;">
        <meta property="og:description" content="What it is about">
        <meta property="og:image" content="/images/cover.jpg">
      </head><body></body></html>`;

    expect(parseOpenGraphMetadata(html, base)).toEqual({
      title: "A & very good 'article'",
      description: "What it is about",
      imageUrl: "https://example.com/images/cover.jpg",
      siteName: "Example Weekly",
    });
  });

  it("falls back to Twitter Card names field by field", () => {
    const html = `
      <meta name="twitter:title" content="Twitter only title">
      <meta property="og:description" content="OG wins where present">
      <meta name="twitter:image:src" content="https://cdn.example/t.png">`;

    expect(parseOpenGraphMetadata(html, base)).toEqual({
      title: "Twitter only title",
      description: "OG wins where present",
      imageUrl: "https://cdn.example/t.png",
      siteName: null,
    });
  });

  it("reads attributes in any order and quote style", () => {
    const html = `<meta content='Single quotes first' property=og:title>`;
    expect(parseOpenGraphMetadata(html, base)?.title).toBe("Single quotes first");
  });

  it("returns null when there is no title — the no-payload case", () => {
    const html = `<meta property="og:description" content="description alone is not a card">
      <title>A document title is not Open Graph either</title>`;
    expect(parseOpenGraphMetadata(html, base)).toBeNull();
  });

  it("drops an image URL that resolves to a non-http scheme and truncates overlong text", () => {
    const html = `
      <meta property="og:title" content="${"t".repeat(400)}">
      <meta property="og:description" content="${"d".repeat(600)}">
      <meta property="og:image" content="javascript:alert(1)">`;

    const metadata = parseOpenGraphMetadata(html, base);
    expect(metadata).not.toBeNull();
    expect(metadata!.title.length).toBe(300);
    expect(metadata!.description?.length).toBe(500);
    expect(metadata!.imageUrl).toBeNull();
  });
});
