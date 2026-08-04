import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { paraglideVitePlugin } from "@inlang/paraglide-js";
import path from "node:path";

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
  plugins: [
    tailwindcss(),
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
    }),
    react(),
    paraglideVitePlugin({
      project: "./project.inlang",
      outdir: "./src/paraglide",
      emitTsDeclarations: true,
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
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
