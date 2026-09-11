import { defineConfig } from "vitest/config";

const integrationEnvironment = {
  BETTER_AUTH_SECRET: "vitest-integration-secret-at-least-32-chars",
  BETTER_AUTH_URL: "http://localhost:3001",
  WEB_ORIGIN: "http://localhost:3001",
  DATABASE_URL: "",
};

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          root: import.meta.dirname,
          environment: "node",
          include: ["src/**/*.test.ts"],
          exclude: ["src/**/*.int.test.ts"],
          env: { DATABASE_URL: "" },
        },
      },
      {
        test: {
          name: "integration",
          root: import.meta.dirname,
          environment: "node",
          include: ["src/**/*.int.test.ts"],
          // Each file has its own ephemeral workerd database; keep startup
          // bounded while running the existing integration portfolio.
          fileParallelism: false,
          testTimeout: 15_000,
          hookTimeout: 30_000,
          env: integrationEnvironment,
        },
      },
    ],
  },
});
