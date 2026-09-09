import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/benchmark.ts", "src/smoke.ts"],
  format: ["esm"],
  platform: "node",
  target: "node24",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  splitting: false,
  noExternal: [/^@my-tuums\//],
});
