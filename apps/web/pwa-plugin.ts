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

function serviceWorkerSource(cacheName: string, resources: string[]): string {
  return `const CACHE_NAME = ${JSON.stringify(cacheName)};
const APP_SHELL = ${JSON.stringify(resources)};

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
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put("/", response.clone())));
          }
          return response;
        })
        .catch(() => caches.match("/").then((response) => response ?? Response.error())),
    );
    return;
  }

  event.respondWith(caches.match(request).then((response) => response ?? fetch(request)));
});
`;
}
