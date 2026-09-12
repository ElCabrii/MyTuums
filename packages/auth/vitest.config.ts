import { defineConfig } from "vitest/config";

/**
 * Pure email/account-rule tests. D1/auth flows live in packages/api integration
 * tests; apps/server also exercises auth and rendering in native workerd.
 * Factories receive explicit configuration, and this suite never loads .env.
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

    // Legacy tooling must never inherit a developer's PostgreSQL target here.
    env: { DATABASE_URL: "" },
  },
});
