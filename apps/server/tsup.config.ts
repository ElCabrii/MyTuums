import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  splitting: false,
  // `packages/{db,auth,api}` are source-only internal packages: their
  // `exports` point straight at `.ts` files with `.js` specifiers. Node's
  // native type-stripping does not rewrite those specifiers, so importing
  // the unbundled output fails at runtime (`Cannot find module '.../router.js'`).
  // Inlining them here is the fix — everything matching `@my-tuums/*` gets
  // bundled into dist/index.js instead of left as an external `require`.
  // Real npm dependencies (better-auth, @orpc/server, drizzle-orm, postgres,
  // zod, ...) stay external and are resolved from node_modules at runtime.
  noExternal: [/^@my-tuums\//],
});
