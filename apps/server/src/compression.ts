/**
 * Content-negotiation for text compression, shared by the static-file handler
 * and the response decorator (which compresses JSON bodies on the request
 * path). The q-value parsing lives here so the two callers cannot drift.
 */

/** The encodings this server can emit for text, or `null` for identity (no compression). */
export type Compression = "br" | "gzip" | null;

/**
 * The best compression this client accepts, or `null` for identity.
 *
 * Reads the q-values properly rather than substring-matching: `gzip;q=0` means
 * "gzip refused" even though the token is present, and a client that names only
 * one encoding should not get the other. Ties (the common `br, gzip` case) go
 * to brotli, which wins by a comfortable margin on text.
 */
export function bestEncoding(acceptEncoding: string | undefined): Compression {
  if (!acceptEncoding) return null;

  let brotli = 0;
  let gzip = 0;
  for (const part of acceptEncoding.split(",")) {
    const [name, ...params] = part.trim().split(";");
    const qParam = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    const q = qParam ? Number.parseFloat(qParam.slice(2)) : 1;
    const value = Number.isFinite(q) ? q : 0;
    if (name.trim() === "br" && value > brotli) brotli = value;
    if (name.trim() === "gzip" && value > gzip) gzip = value;
  }

  if (brotli <= 0 && gzip <= 0) return null;
  return brotli >= gzip ? "br" : "gzip";
}
