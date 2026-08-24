import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { paraglideVitePlugin } from "@inlang/paraglide-js";
import { preloadInjectionPlugin } from "./build-inject-plugin";
import { pwaPlugin } from "./pwa-plugin";
import path from "node:path";
import pkg from "./package.json";

// Where /rpc and /api/auth are proxied in dev. Overridable so the E2E suite
// can point the web app at its own server on a different port and run beside
// a live `pnpm dev` (or the docker container) instead of fighting it for 3001.
const rpcTarget = process.env.RPC_TARGET ?? "http://localhost:3001";

export default defineConfig({
  // Vite only loads .env files from its own project root by default, which is
  // apps/web — not the monorepo root where the real .env lives (every other
  // process here reads that one via `dotenv -e ../../.env`, e.g.
  // packages/db's scripts). Without this, VITE_GOOGLE_CLIENT_ID and
  // VITE_SOCIAL_PROVIDERS are invisible to import.meta.env, so no OAuth
  // buttons and no One Tap ever render, with nothing in the console to say
  // why - the code has no missing dependency, it just never saw the values.
  envDir: path.resolve(__dirname, "../.."),
  define: {
    // The footer's "v0.4.2" and the header's alpha/beta tag come from
    // package.json's `version` field, inlined here rather than read at
    // runtime — no env file or API round-trip to drift from the release
    // the bundle was built from. Declared for TS in src/vite-env.d.ts;
    // vitest.config.ts carries a stand-in define of its own because it
    // deliberately does not load this file.
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [
    tailwindcss(),
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
      // Route tests live beside their route modules, but they do not export a
      // `Route`. Ignoring them up front keeps the generator from warning on
      // every build while preserving the colocated test layout.
      routeFileIgnorePattern: "\\.test\\.tsx$",
    }),
    react(),
    paraglideVitePlugin({
      project: "./project.inlang",
      outdir: "./src/paraglide",
      emitTsDeclarations: true,
    }),
    // Post-build HTML surgery: modulepreload for the lazy login chunk, font
    // preload, non-blocking stylesheet. `enforce: "post"` inside the plugin
    // is what lets it see the final index.html — see build-inject-plugin.ts.
    preloadInjectionPlugin(),
    // Emits a versioned, hashed-asset precache without adding a Workbox-sized
    // dependency for the app's intentionally small offline-shell policy.
    pwaPlugin(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  // Pre-bundle every @base-ui module the app imports. Vite's dep optimizer
  // runs on demand: the first time a module graph that reaches a not-yet-
  // optimized dependency is requested, Vite discovers it, re-bundles, and
  // full-reloads the page. Most of the app's chunks are lazy routes, so at
  // runtime that first use can land in the middle of a user session — and in
  // the E2E suite (which boots a fresh dev server per run, playwright.config.ts)
  // it would wipe the page mid-interaction and fail the spec. Listing them
  // here moves the optimization to server start, where it belongs.
  optimizeDeps: {
    include: [
      "@base-ui/react/avatar",
      "@base-ui/react/button",
      "@base-ui/react/dialog",
      "@base-ui/react/input",
      "@base-ui/react/menu",
      "@base-ui/react/merge-props",
      "@base-ui/react/popover",
      "@base-ui/react/select",
      "@base-ui/react/tabs",
      "@base-ui/react/use-render",
    ],
  },
  build: {
    // Source maps for the production bundle. This is a public repo, so the
    // original TS is on GitHub anyway; the maps only ever download when
    // DevTools is open, and the server already serves assets/ with immutable
    // caching. They cost image size (~2-3x the JS) and nothing on the runtime
    // path — what they buy is a stack trace that points at source instead of
    // one 578 KB minified line. `hidden` would not do: Lighthouse (and
    // DevTools) find maps through the sourceMappingURL comment, which `hidden`
    // deliberately omits.
    //
    // Note: Lighthouse's valid-source-maps audit still flags the main chunk —
    // its gatherer fetches the map with a 1.5 s budget, and a ~3 MB map
    // exceeds it even on localhost (verified over CDP; the audit is
    // weight-0, so no score impact). The maps themselves work: DevTools
    // fetches them on demand with no such budget.
    sourcemap: true,
    // The two heavy, rarely-changing runtime layers get their own chunks so a
    // cache-busting release of app code doesn't force re-downloads of them, and
    // so neither ends up duplicated across the lazy component chunks. The rest
    // of the graph stays with Vite's default splitter.
    //
    // Only packages the web app declares directly are listed: Rollup resolves
    // these entries from the app root, and under pnpm's strict node_modules the
    // router's own transitive deps (`@tanstack/history`, `@tanstack/router-core`,
    // `@tanstack/react-store`) are not linked there. That's fine — nothing in
    // the graph imports them outside `@tanstack/react-router`, so Rollup folds
    // them into the router-vendor chunk on its own.
    rollupOptions: {
      output: {
        manualChunks: {
          "react-vendor": ["react", "react-dom", "react-dom/client"],
          "router-vendor": ["@tanstack/react-router"],
        },
      },
    },
  },
  server: {
    proxy: {
      "/rpc": {
        target: rpcTarget,
        changeOrigin: true,
      },
      "/api/auth": {
        target: rpcTarget,
        changeOrigin: true,
      },
      // Uploaded avatars and banners. The server answers these with a 302 to a
      // presigned bucket URL, so the proxy must NOT follow the redirect —
      // `autoRedirect` is off by default, and the browser has to be the one
      // that follows it or the bytes would be pulled through this dev server.
      //
      // In production there is no proxy: the web app and the API are one
      // origin, which is the same assumption `src/lib/orpc.ts` already makes
      // by resolving `/rpc` against `window.location.origin`. That is what
      // lets a stored `/media/...` path work unchanged in both places.
      "/media": {
        target: rpcTarget,
        changeOrigin: true,
      },
    },
  },
});
