import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import path from "node:path";

// Deliberately not `mergeConfig(viteConfig, ...)`: the app's vite config
// pulls in the TanStack Router and Paraglide code generators, which want to
// (re)write files in src/ on startup. A test run has no business regenerating
// the route tree, so this declares the small part the tests actually need —
// JSX compilation and the "@/" alias.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  test: {
    // Component tests need a DOM; the pure helpers under src/lib don't care.
    environment: "jsdom",
    globals: false,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
