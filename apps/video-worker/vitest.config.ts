import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
          exclude: ["src/**/*.media.test.ts"],
          env: { DATABASE_URL: "" },
        },
      },
      {
        test: {
          name: "media",
          include: ["src/**/*.media.test.ts"],
          fileParallelism: false,
          testTimeout: 120_000,
          hookTimeout: 120_000,
          env: { DATABASE_URL: "" },
        },
      },
    ],
  },
});
