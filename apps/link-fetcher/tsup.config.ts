import { defineConfig } from "tsup";
export default defineConfig({
  entry: ["src/server.ts"],
  format: ["cjs"],
  platform: "node",
  target: "node24",
  bundle: true,
  noExternal: ["@my-tuums/api", "undici", "zod"],
  clean: true,
});
