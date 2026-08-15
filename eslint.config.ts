// The monorepo's single ESLint flat config — every package lints against
// this file via turbo's `lint` task. Type-aware rules are the point:
// `projectService` below plus the three promise rules that have caught
// real bugs in the server.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

/**
 * Monorepo-wide ESLint flat config: type-aware rules (one program per
 * tsconfig, discovered via projectService) plus the deliberate
 * promise-safety trio that fixed a floating-promise bug in the server.
 */
export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.turbo/**",
      "apps/web/src/paraglide/**",
      "packages/db/drizzle/**",
      "e2e/test-results/**",
      "e2e/playwright-report/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  // The react-hooks plugin's flat-config entrypoint, scoped to the web app:
  // it is the only React surface in the monorepo, and the rules misfire
  // elsewhere — Playwright fixtures name their handoff callback `use`
  // (`async ({ browser }, use) => …`), which rules-of-hooks misreads as
  // React 19's `use` hook in a non-component (e2e/support/fixtures.ts).
  //
  // v7 still ships its configs in eslintrc shape (`plugins: ["react-hooks"]`
  // — a string array, which flat config rejects outright), so the rules are
  // taken verbatim from the entrypoint while the plugin itself is
  // registered in the object form flat config requires. No rule is added,
  // removed or has its severity changed here; the entrypoint remains the
  // single source of truth.
  {
    files: ["apps/web/**"],
    plugins: { "react-hooks": reactHooks },
    rules: reactHooks.configs.flat.recommended.rules,
  },
  {
    languageOptions: {
      parserOptions: {
        // "Project service" — one program per tsconfig.json, discovered
        // automatically for every file under this monorepo. No explicit
        // `project` array needed (see typescript-eslint's monorepo docs).
        projectService: {
          // Config/build files that sit outside any tsconfig's `include`
          // (e.g. apps/web/tsconfig.json only includes "src") still get
          // linted with type information, using the nearest tsconfig as a
          // stand-in rather than being skipped or crashing the run.
          //
          // `eslint.config.ts` itself is NOT here: the root tsconfig.json
          // (node.json profile) includes it, so it joins the project
          // service like any source file. Before that tsconfig existed, the
          // stand-in could not resolve this file's imports — everything
          // read as `error` typed, and linting the config against itself
          // failed with no-unsafe-* errors on lines that were not actually
          // unsafe.
          allowDefaultProject: [
            "packages/db/drizzle.config.ts",
            "apps/server/tsup.config.ts",
            // `apps/server/tsconfig.json` sets `rootDir: "src"`, so this one
            // cannot join its `include` the way the other vitest configs join
            // theirs. It is object literals only, so the weaker inferred
            // typing has nothing unsafe to trip over.
            "apps/server/vitest.config.ts",
            // The root tsconfig.json includes only eslint.config.ts, so the
            // docs checker has no project of its own; the root tsconfig
            // stands in for it.
            "scripts/check-docs.ts",
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // These three are the point of turning typed linting on at all: they
      // caught a real floating-promise bug in apps/server/src/index.ts, and
      // they are what stops it coming back unnoticed.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/require-await": "error",
    },
  },
  {
    // Plain Node build scripts, run by `node` or `tsx` and never bundled or
    // imported by the app. There's no tsconfig that covers them, so type-aware
    // linting has nothing to work from — it reports every import as `error`
    // typed rather than finding anything real. Syntax and correctness rules
    // still apply.
    files: ["**/scripts/**/*.ts"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
      },
    },
  },
);
