import { defineConfig } from "tsup";

export default defineConfig({
  // Five entry points: the server, the pre-deploy migration runner (see
  // src/migrate.ts), the promote-user CLI (see src/promote.ts), the one-off
  // Founder-badge grant (see src/grant-founder-badge.ts), and the game-catalog
  // sync the Railway cron service runs weekly (see src/games-sync.ts). All
  // are bundled the same way so the runtime image needs no dev dependencies
  // to migrate, appoint the first moderators, grant the Founder badge, or
  // refresh the game catalog.
  entry: [
    "src/index.ts",
    "src/migrate.ts",
    "src/promote.ts",
    "src/grant-founder-badge.ts",
    "src/games-sync.ts",
  ],
  format: ["esm"],
  platform: "node",
  target: "node24",
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
