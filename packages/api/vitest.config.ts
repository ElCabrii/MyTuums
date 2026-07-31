import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // These hit a real Postgres instance through @my-tuums/db and exercise
    // the actual BetterAuth sign-up + session flow (see src/router.test.ts)
    // — genuine integration tests, not isolated units. Requires
    // `docker compose up -d postgres` (or an equivalent DATABASE_URL) and
    // env loaded from the repo root .env (see the "test" script).
    testTimeout: 15000,
  },
});
