// @ts-check
// The monorepo's single ESLint flat config — every package lints against
// this file via turbo's `lint` task. Type-aware rules are the point:
// `projectService` below plus the three promise rules that have caught
// real bugs in the server.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

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
          allowDefaultProject: [
            "eslint.config.mjs",
            "packages/db/drizzle.config.ts",
            "apps/server/tsup.config.ts",
            // `apps/server/tsconfig.json` sets `rootDir: "src"`, so this one
            // cannot join its `include` the way the other vitest configs join
            // theirs. It is object literals only, so the weaker inferred
            // typing has nothing unsafe to trip over.
            "apps/server/vitest.config.ts",
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // These three are the point of turning typed linting on at all —
      // Step 3 fixed a floating-promise bug in apps/server/src/index.ts by
      // hand; these make sure it can't come back unnoticed.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/require-await": "error",
    },
  },
  {
    // Plain Node build scripts, run by `node` and never bundled or imported
    // by the app. There's no tsconfig that covers them, so type-aware linting
    // has nothing to work from — it reports every import as `error` typed
    // rather than finding anything real. Syntax and correctness rules still
    // apply.
    files: ["**/scripts/**/*.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
      },
    },
  },
);
