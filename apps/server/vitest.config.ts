import { defineConfig } from "vitest/config";

// Pure boundary tests and native runtime/artifact fixtures. Deployment bundles
// must be built before artifact checks; fixture entrypoints are never deployed.
export default defineConfig({
  test: {
    name: "server",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
