import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { paraglideVitePlugin } from "@inlang/paraglide-js";
import path from "node:path";
import { crawlerDocuments } from "../web/crawler-documents-plugin.ts";

const appOrigin = process.env.VITE_WEB_ORIGIN ?? "https://preview.mytuums.com";
const production = appOrigin === "https://mytuums.com";
if (!["https://preview.mytuums.com", "https://mytuums.com"].includes(appOrigin))
  throw new Error("Unsupported branding application origin.");
const brandingOrigin = production
  ? "https://about.mytuums.com"
  : "https://branding-preview.invalid";

// The branding site is a second, tiny Vite app — deliberately NOT part of
// apps/web. The SPA is a signed-in application whose every route assumes a
// session and the one-origin contract (/rpc, /media, host-only cookies);
// the landing page at about.mytuums.com needs none of that, so it gets its
// own build with no router, no state library and no API client. What it does
// share is everything visual: the same Tailwind v4 setup, the same shadcn
// preset (components.json), the same Inter Variable font and the same
// Paraglide message pipeline, so the two sites can never look or read like
// different products.
//
// The default artifact uses a non-routable private origin; hosted deployments
// supply their explicit public application origin.
export default defineConfig({
  define: { "import.meta.env.VITE_WEB_ORIGIN": JSON.stringify(appOrigin) },
  plugins: [
    crawlerDocuments(path.resolve(import.meta.dirname, "crawler-documents"), production),
    {
      name: "mytuums-branding-origin",
      transformIndexHtml: {
        order: "pre",
        handler: (html) =>
          html
            .replaceAll("https://branding-preview.invalid", brandingOrigin)
            .replaceAll("https://preview.mytuums.com", appOrigin),
      },
    },
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
