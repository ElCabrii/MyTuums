import { NONBLOCKING_STYLESHEET_ONLOAD_HANDLER } from "@my-tuums/api/constants";

let stylesheetHash: Promise<string> | undefined;

/** Native counterpart of the Node response decorator; Cloudflare handles compression. */
export async function workerResponseHeaders(options: {
  googleAnalytics?: boolean;
  streamOrigins: readonly string[];
}): Promise<Readonly<Record<string, string>>> {
  // Compute lazily inside a request; Workers forbid startup-time asynchronous I/O.
  stylesheetHash ??= crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(NONBLOCKING_STYLESHEET_ONLOAD_HANDLER))
    .then((hash) => `sha256-${btoa(String.fromCharCode(...new Uint8Array(hash)))}`);
  const analyticsScript = options.googleAnalytics ? " https://www.googletagmanager.com" : "";
  const analyticsConnections = options.googleAnalytics
    ? " https://*.google-analytics.com https://*.analytics.google.com https://www.googletagmanager.com"
    : "";
  const media = options.streamOrigins
    .map((value) => {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password)
        throw new Error("Invalid media origin.");
      return ` ${url.origin}`;
    })
    .join("");
  return {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "Content-Security-Policy": [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "img-src 'self' https: blob:",
      "font-src 'self'",
      `script-src 'self' https://accounts.google.com${analyticsScript} 'unsafe-hashes' '${await stylesheetHash}'`,
      "style-src 'self' 'unsafe-inline' https://accounts.google.com",
      `connect-src 'self' https://accounts.google.com${analyticsConnections}${media}`,
      `media-src 'self' blob:${media}`,
      "worker-src 'self' blob:",
      "frame-src https://accounts.google.com",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
  };
}
