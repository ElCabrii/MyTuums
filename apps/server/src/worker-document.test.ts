import { expect, it } from "vitest";
import { createWorkerDocumentTransform } from "./worker-document.js";

it("replaces a document without retaining stale length, compression, validators or public caching", async () => {
  const transform = createWorkerDocumentTransform((path, html) =>
    Promise.resolve(`${html}<title>${path}</title>`),
  );
  const response = await transform(
    new Response("<html></html>", {
      headers: {
        "content-type": "text/html",
        "content-length": "13",
        etag: "synthetic-asset",
        "last-modified": "Thu, 10 Sep 2026 00:00:00 GMT",
        "cache-control": "public, max-age=3600",
      },
    }),
    new Request("https://cf-poc.example.com/login"),
  );
  expect(await response.text()).toContain("<title>/login</title>");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  for (const name of ["content-length", "content-encoding", "etag", "last-modified"])
    expect(response.headers.has(name)).toBe(false);
});

it("refuses oversized and compressed asset bodies instead of treating them as HTML", async () => {
  const transform = createWorkerDocumentTransform((path, html) => Promise.resolve(html));
  const request = new Request("https://cf-poc.example.com/login");
  await expect(
    transform(
      new Response("x".repeat(1024 * 1024 + 1), {
        headers: { "content-type": "text/html" },
      }),
      request,
    ),
  ).rejects.toThrow("size limit");
  await expect(
    transform(
      new Response("compressed bytes", {
        headers: { "content-type": "text/html", "content-encoding": "gzip" },
      }),
      request,
    ),
  ).rejects.toThrow("uncompressed");
});
