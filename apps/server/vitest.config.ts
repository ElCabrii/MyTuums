import { defineConfig } from "vitest/config";

/**
 * Unit tests only, and only for the pure modules.
 *
 * `src/index.ts` is deliberately out of reach here: importing it evaluates
 * `env.ts`, which calls `process.exit(1)` on invalid input, and installs
 * `unhandledRejection`/`uncaughtException` handlers that also exit — any of
 * which would take the test runner down with it. The server's HTTP behaviour
 * is covered against a real spawned process by the Playwright `api` project
 * in `e2e/` instead.
 */
export default defineConfig({
  test: {
    name: "server",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
