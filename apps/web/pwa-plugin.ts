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
 * Emits a dependency-free service worker whose PRECACHE inventory is the
 * offline shell — and only the shell. Reading `index.html`'s final markup
 * here (after the preload-injection plugin has run) is what identifies the
 * entry chunk, its modulepreload graph and the stylesheet/font the first
 * paint needs, without a second manifest or a Workbox dependency.
 *
 * The 0.4.0 change: the precache used to include EVERY generated asset —
 * 107 URLs and ~1.5 MB, 93 of them JavaScript — which quietly undid the
 * router's route splitting at install time: a first visit downloaded every
 * route's chunk before it could show anything. Route chunks are now fetched
 * on demand and remembered in a runtime cache (`/assets/*` below), so offline
 * coverage still grows with use without ever taxing the first load.
 */
export function pwaPlugin(): Plugin {
  return {
    name: "mytuums-pwa",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      const html = bundle["index.html"];
      if (html?.type !== "asset") return;

      const shellResources = [
        ...new Set([...STATIC_SHELL_RESOURCES, ...hashedRefsOf(String(html.source))]),
      ].sort();
      const fingerprint = createHash("sha256").update(shellResources.join("\n"));
      for (const resource of STATIC_SHELL_RESOURCES) {
        if (resource === "/") continue;
        fingerprint.update(readFileSync(new URL(`./public${resource}`, import.meta.url)));
      }
      fingerprint.update(html.source);
      const version = fingerprint.digest("hex").slice(0, 12);

      this.emitFile({
        type: "asset",
        fileName: "service-worker.js",
        source: serviceWorkerSource(
          `mytuums-shell-${version}`,
          `mytuums-runtime-${version}`,
          shellResources,
        ),
      });
    },
  };
}

/**
 * The `/assets/…` references the built `index.html` itself carries: the entry
 * script, every `modulepreload`, the stylesheet, and font preloads. Those
 * are exactly the subresources the offline shell needs to boot.
 */
function hashedRefsOf(html: string): string[] {
  const refs: string[] = [];
  const patterns = [
    /<script[^>]+src="(\/assets\/[^"]+)"/g,
    /<link[^>]+rel="modulepreload"[^>]+href="(\/assets\/[^"]+)"/g,
    /<link[^>]+href="(\/assets\/[^"]+)"[^>]+rel="modulepreload"/g,
    /<link[^>]+rel="stylesheet"[^>]+href="(\/assets\/[^"]+)"/g,
    /<link[^>]+href="(\/assets\/[^"]+)"[^>]+rel="stylesheet"/g,
    /<link[^>]+rel="preload"[^>]+as="font"[^>]+href="(\/assets\/[^"]+)"/g,
    /<link[^>]+href="(\/assets\/[^"]+)"[^>]+as="font"[^>]+rel="preload"/g,
  ];
  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) refs.push(match[1]);
  }
  return refs;
}

/**
 * The worker source, as a string because it ships as its own top-level script
 * rather than through Vite's module graph. Two constraints are easy to break
 * here and invisible until production:
 *
 * - **The worker only answers for paths it precached, plus `/assets/*` at
 *   runtime.** Every other same-origin GET is left to the browser, which
 *   matters beyond avoiding a pointless cache miss: a `fetch()` issued
 *   *from* a worker is a `connect-src` request whatever the original
 *   destination was, and its redirect target has to pass the same directive.
 *   `/media/<key>` 302s to a presigned URL on the storage bucket, an origin
 *   the policy in `apps/server/src/response-decorators.ts` allows under
 *   `img-src 'self' https:` and deliberately does not enumerate under
 *   `connect-src`. Re-fetch it here and the browser blocks the redirect, the
 *   `respondWith` promise rejects, and every avatar and post image breaks for
 *   anyone with the worker installed.
 * - **The shell clone is taken synchronously.** `caches.open()` is disk-backed
 *   and settles well after the navigation response is handed back, by which
 *   point the browser has consumed its body and `clone()` throws. Cloning
 *   before returning costs nothing and is the only ordering that works.
 *
 * One accepted wrinkle (0.4.0): the server injects per-route crawler heads
 * into `index.html` (`apps/server/src/public-heads.ts`), and this worker
 * caches successful HTML navigations under the single key `/` as the offline
 * shell — so the document served offline may carry another route's title.
 * Offline is best-effort; the SPA replaces the head the moment it boots.
 */
export function serviceWorkerSource(
  cacheName: string,
  runtimeCacheName: string,
  resources: string[],
): string {
  return `const CACHE_NAME = ${JSON.stringify(cacheName)};
const RUNTIME_CACHE_NAME = ${JSON.stringify(runtimeCacheName)};
const APP_SHELL = ${JSON.stringify(resources)};
const SHELL_PATHS = new Set(APP_SHELL);

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter(
              (name) =>
                (name.startsWith("mytuums-shell-") || name.startsWith("mytuums-runtime-")) &&
                name !== CACHE_NAME &&
                name !== RUNTIME_CACHE_NAME,
            )
            .map((name) => caches.delete(name)),
        ),
      )
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

  if (SHELL_PATHS.has(url.pathname)) {
    event.respondWith(caches.match(request).then((response) => response ?? fetch(request)));
    return;
  }

  // Route chunks and every other hashed asset: fetched on demand, remembered
  // here. Cache-first is safe because the names are content-hashed — a build
  // mints new names, and activate above has already dropped the old caches.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.open(RUNTIME_CACHE_NAME).then((cache) =>
        cache.match(request).then((hit) => {
          if (hit) return hit;
          return fetch(request).then((response) => {
            if (response.ok) event.waitUntil(cache.put(request, response.clone()));
            return response;
          });
        }),
      ),
    );
  }
});
`;
}
