import { defineConfig } from "vitest/config";

/**
 * Unit tests only.
 *
 * There is no integration project here on purpose: `packages/api` already
 * exercises the _production_ auth instance against a real Postgres, and
 * duplicating that would hand this package a database dependency its modules
 * do not have. What this package owns outright — the email HTML rendering and
 * the account rules — is pure, so a unit project is the whole setup.
 *
 * Nothing here may read the root `.env`: `src/env.ts` resolves every variable
 * at module load with a usable default, which is exactly what lets these tests
 * (and the Better Auth CLI) import the package with no environment at all.
 */
export default defineConfig({
  test: {
    name: "auth",
    environment: "node",
    include: ["src/**/*.test.ts"],
    // `*` spans dots, so the include also matches `*.int.test.ts`; exclude it
    // explicitly like `packages/api`'s unit project does, so a file following
    // the repo's integration naming convention can never land in this
    // database-less project.
    exclude: ["src/**/*.int.test.ts"],

    // Same structural guard as `packages/api`'s unit project: this package's
    // `index.ts` and `testing.ts` both construct a Better Auth instance over
    // `@my-tuums/db`, which throws on a falsy DATABASE_URL at module scope. A
    // test here that reaches for either fails by name instead of quietly
    // connecting to whatever database the shell happened to point at.
    env: { DATABASE_URL: "" },
  },
});
