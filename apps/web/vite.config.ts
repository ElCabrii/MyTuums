import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { paraglideVitePlugin } from "@inlang/paraglide-js";
import path from "node:path";

export default defineConfig({
  plugins: [
    tailwindcss(),
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
      // Route components are tested from files sitting next to them in
      // src/routes/, and the generator otherwise treats every .tsx under that
      // directory as a route — it warns about each one and, worse, the naming
      // workaround for it (calling the profile test `profile.test.tsx` rather
      // than `@{$username}.test.tsx`) is invisible tribal knowledge. This
      // makes co-locating route tests explicitly safe.
      routeFileIgnorePattern: "\\.test\\.",
    }),
    react(),
    paraglideVitePlugin({
      project: "./project.inlang",
      outdir: "./src/paraglide",
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
        target: "http://localhost:3001",
        changeOrigin: true,
      },
      "/api/auth": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
});
