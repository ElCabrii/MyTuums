import path from "node:path";
import react from "@vitejs/plugin-react-swc";
import { defineConfig } from "vitest/config";

/**
 * Deliberately NOT `mergeConfig(viteConfig)`.
 *
 * `vite.config.ts` carries the TanStack Router and Paraglide plugins, both of
 * which write into `src/` on startup — a router tree and a message bundle
 * regenerated underneath a running test process. Only the React plugin is
 * needed to compile JSX, so only the React plugin is here.
 *
 * The cost of leaving Paraglide out is that `src/paraglide/**` (generated and
 * git-ignored) must already exist. `pretest` in package.json compiles it, so a
 * clean clone still works.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  test: {
    name: "web",
    environment: "jsdom",

    // Explicit imports of `describe`/`it`/`expect` everywhere. The cost is a
    // line per file; the benefit is that Testing Library's auto-cleanup does
    // not silently register itself, so teardown is visible in setup.ts rather
    // than implied.
    globals: false,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    css: false,
  },
});
