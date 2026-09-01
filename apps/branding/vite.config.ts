import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { paraglideVitePlugin } from "@inlang/paraglide-js";
import path from "node:path";

// The branding site is a second, tiny Vite app — deliberately NOT part of
// apps/web. The SPA is a signed-in application whose every route assumes a
// session and the one-origin contract (/rpc, /media, host-only cookies);
// the landing page at home.mytuums.com needs none of that, so it gets its
// own build with no router, no state library and no API client. What it does
// share is everything visual: the same Tailwind v4 setup, the same shadcn
// preset (components.json), the same Inter Variable font and the same
// Paraglide message pipeline, so the two sites can never look or read like
// different products.
//
// The server serves this app's dist when `Host` is home.mytuums.com
// (BRANDING_DIST in apps/server) — see apps/server/src/request-handler.ts.
export default defineConfig({
  plugins: [
    tailwindcss(),
    react(),
    paraglideVitePlugin({
      project: "./project.inlang",
      outdir: "./src/paraglide",
      emitTsDeclarations: true,
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
});
