import { defineConfig } from "tsup";

export default defineConfig({
  // Three entry points: the server, the pre-deploy migration runner (see
  // src/migrate.ts), and the promote-user CLI (see src/promote.ts). All are
  // bundled the same way so the runtime image needs no dev dependencies to
  // migrate or to appoint the first moderators.
  entry: ["src/index.ts", "src/migrate.ts", "src/promote.ts"],
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
  // Only the packages THIS app declares in `dependencies` (better-auth,
  // @orpc/server, zod, @sentry/node, @opentelemetry/core) stay external
  // and are resolved from node_modules at
  // runtime; tsup follows a bundled module's imports, so the transitive npm
  // deps of the inlined workspace packages (drizzle-orm, postgres, ...) are
  // bundled too — grep the external `from "..."` imports in dist/index.js
  // to re-verify. The Dockerfile's runner stage installs accordingly (see
  // its header comment), so nothing here may silently become external
  // without also becoming a declared dependency.
  noExternal: [/^@my-tuums\//],
});
