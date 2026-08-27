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
  },
});
