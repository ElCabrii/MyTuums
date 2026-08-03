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
