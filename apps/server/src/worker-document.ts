/** The trusted build document is still bounded; a wrong asset must not exhaust the isolate. */
const MAX_DOCUMENT_BYTES = 1024 * 1024;

export function createWorkerDocumentTransform(
  transform: (pathname: string, html: string) => Promise<string>,
) {
  return async (response: Response, request: Request): Promise<Response> => {
    if (!response.headers.get("content-type")?.toLowerCase().startsWith("text/html")) {
      await response.body?.cancel().catch(() => {});
      throw new Error("Invalid app document type.");
    }
    const encoding = response.headers.get("content-encoding");
    if (encoding && encoding !== "identity") {
      await response.body?.cancel().catch(() => {});
      throw new Error("Expected an uncompressed app document.");
    }
    if (!response.body) throw new Error("Missing app document.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
    let html = "";
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const bytes: unknown = chunk.value;
        if (!(bytes instanceof Uint8Array)) throw new Error("Invalid app document bytes.");
        size += bytes.byteLength;
        if (size > MAX_DOCUMENT_BYTES) throw new Error("App document exceeds its size limit.");
        html += decoder.decode(bytes, { stream: true });
      }
      html += decoder.decode();
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const headers = new Headers(response.headers);
    // The route-specific document no longer has the stored asset's bytes or
    // validators. Never reuse a public cache policy for a visibility-sensitive head.
    for (const name of ["content-length", "content-encoding", "etag", "last-modified"])
      headers.delete(name);
    headers.set("cache-control", "private, no-store");
    headers.set("content-type", "text/html; charset=utf-8");
    return new Response(await transform(new URL(request.url).pathname, html), { headers });
  };
}
