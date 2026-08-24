import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Plugin } from "vite";

const STATIC_SHELL_RESOURCES = [
  "/",
  "/apple-touch-icon.png",
  "/manifest.webmanifest",
  "/mytuums.svg",
  "/mytuums-192.png",
  "/mytuums-512.png",
];

/**
 * Emits a dependency-free service worker whose precache inventory comes from
 * Vite's final bundle. Reading the bundle here is what lets the worker cache
 * hashed route chunks and styles without a second manifest or a Workbox
 * dependency that only this small offline-shell policy would use.
 */
export function pwaPlugin(): Plugin {
  return {
    name: "mytuums-pwa",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      const generatedResources = Object.values(bundle)
        .filter((entry) => entry.fileName.startsWith("assets/") && !entry.fileName.endsWith(".map"))
        .map((entry) => `/${entry.fileName}`)
        .sort();
      const resources = [...STATIC_SHELL_RESOURCES, ...generatedResources];
      const fingerprint = createHash("sha256").update(resources.join("\n"));
      for (const resource of STATIC_SHELL_RESOURCES) {
        if (resource === "/") continue;
        fingerprint.update(readFileSync(new URL(`./public${resource}`, import.meta.url)));
      }
      const html = bundle["index.html"];
      if (html?.type === "asset") fingerprint.update(html.source);
      const version = fingerprint.digest("hex").slice(0, 12);

      this.emitFile({
        type: "asset",
        fileName: "service-worker.js",
        source: serviceWorkerSource(`mytuums-shell-${version}`, resources),
      });
    },
  };
}

/**
 * The worker source, as a string because it ships as its own top-level script
 * rather than through Vite's module graph. Two constraints are easy to break
 * here and invisible until production:
 *
 * - **The worker only answers for paths it precached.** Every other
 *   same-origin GET is left to the browser, which matters beyond avoiding a
 *   pointless cache miss: a `fetch()` issued *from* a worker is a `connect-src`
 *   request whatever the original destination was, and its redirect target has
 *   to pass the same directive. `/media/<key>` 302s to a presigned URL on the
 *   storage bucket, an origin the policy in
 *   `apps/server/src/response-decorators.ts` allows under `img-src 'self'
 *   https:` and deliberately does not enumerate under `connect-src`. Re-fetch
 *   it here and the browser blocks the redirect, the `respondWith` promise
 *   rejects, and every avatar and post image breaks for anyone with the worker
 *   installed.
 * - **The shell clone is taken synchronously.** `caches.open()` is disk-backed
 *   and settles well after the navigation response is handed back, by which
 *   point the browser has consumed its body and `clone()` throws. Cloning
 *   before returning costs nothing and is the only ordering that works.
 */
export function serviceWorkerSource(cacheName: string, resources: string[]): string {
  return `const CACHE_NAME = ${JSON.stringify(cacheName)};
const APP_SHELL = ${JSON.stringify(resources)};
const SHELL_PATHS = new Set(APP_SHELL);

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name.startsWith("mytuums-shell-") && name !== CACHE_NAME).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
          if (response.ok && new URL(response.url).origin === self.location.origin && contentType === "text/html") {
            const shell = response.clone();
            event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put("/", shell)));
          }
          return response;
        })
        .catch(() => caches.match("/").then((response) => response ?? Response.error())),
    );
    return;
  }

  if (!SHELL_PATHS.has(url.pathname)) return;
  event.respondWith(caches.match(request).then((response) => response ?? fetch(request)));
});
`;
}
