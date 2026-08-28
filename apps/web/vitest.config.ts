import path from "node:path";
import react from "@vitejs/plugin-react-swc";
import { configDefaults, defineConfig } from "vitest/config";

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
 *
 * The environment is decided by the project split below, not by per-file
 * docblocks: the file's extension is its environment declaration.
 *
 * - `*.test.ts`    → `node`: pure client logic. A document/window dependency
 *                    fails loudly here instead of silently gaining jsdom.
 * - `*.test.tsx`   → `dom` (jsdom): rendered React behaviour.
 * - `*.dom.test.ts`→ `dom` (jsdom): the rare non-React test that genuinely
 *                    owns document behaviour (canvas, `document.head`,
 *                    `window.location`).
 *
 * `test:node` / `test:dom` run one project alone (`--project`). Project
 * configs do not inherit the root Vite block, so `base()` builds a fresh Vite
 * block per project — the plugin instance in particular must not be shared
 * between the two Vite servers, or the second one silently drops options.
 *
 * The overlap with vite.config.ts is three lines (the `@` alias and the React
 * plugin call) and stays duplicated on purpose: a shared factory would split
 * each config's plugin list across two files to deduplicate one path mapping,
 * and the `__APP_VERSION__` define must differ between the two anyway.
 */
const base = () => ({
  plugins: [react()],
  define: {
    // Stand-in only: vitest.config.ts deliberately does not load
    // vite.config.ts (see the note above), so src/lib/app-version.ts's
    // module-level constants need this global to exist for the module to
    // evaluate. The helper under test takes the version as a parameter, so
    // this value is never asserted — package.json via vite.config.ts remains
    // the single source of truth for the bundle.
    __APP_VERSION__: JSON.stringify("0.0.0"),
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
});

export default defineConfig({
  test: {
    // Explicit imports of `describe`/`it`/`expect` everywhere. The cost is a
    // line per file; the benefit is that Testing Library's auto-cleanup does
    // not silently register itself, so teardown is visible in the dom setup
    // rather than implied.
    globals: false,
    css: false,
    projects: [
      {
        ...base(),
        test: {
          name: "node",
          environment: "node",
          include: ["src/**/*.test.ts"],
          exclude: ["src/**/*.dom.test.ts", ...configDefaults.exclude],
          setupFiles: ["./src/test/setup-node.ts"],
        },
      },
      {
        ...base(),
        test: {
          name: "dom",
          environment: "jsdom",
          include: ["src/**/*.test.tsx", "src/**/*.dom.test.ts"],
          setupFiles: ["./src/test/setup-dom.ts"],
        },
      },
    ],
  },
});
