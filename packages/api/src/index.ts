/**
 * The package root: what `apps/server` wires into the request handler and the
 * web client calls. The browser-safe subpaths (`constants`, `dimensions`,
 * `storage` types) are exported separately in package.json on purpose — see
 * ./constants.ts for why the root must never be imported from the web app.
 */
export { appRouter, type AppRouter } from "./router.js";
export { createContext, defaultStorage } from "./context.js";
export { createMediaResolver, type MediaAuthorizer, type MediaResolver } from "./media.js";
export { canViewPostMedia } from "./post-media.js";
export { objectKeyFromMediaPath } from "./image.js";
export type { Storage } from "./storage.js";
