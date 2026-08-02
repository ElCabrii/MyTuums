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
    },
  },
});
