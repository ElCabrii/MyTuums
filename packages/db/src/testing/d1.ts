import { Miniflare } from "miniflare";
import { migrate } from "drizzle-orm/d1/migrator";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/d1";
import { createDatabase } from "../index.js";

/** The committed migration set — the default `createTestDatabase` applies all of it. */
export const committedMigrationsFolder = fileURLToPath(
  new URL("../../drizzle-d1", import.meta.url),
);

/**
 * Ephemeral workerd database: no production credentials, remote bindings or
 * persistent path.
 *
 * `migrationsFolder` swaps the applied set — an upgrade test points it at a
 * copy of `drizzle-d1` whose journal stops before the migration under test,
 * seeds the old world's rows, then re-runs the migrator against the full
 * folder to apply just that migration over real data.
 */
export async function createTestDatabase(options?: { migrationsFolder?: string }) {
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "database-test",
          type: "worker",
          compatibilityDate: "2026-09-10",
          manifest: {
            mainModule: "index.js",
            modules: {
              "index.js": {
                type: "esm",
                contents:
                  "export default { fetch() { return new Response(null, { status: 404 }); } }",
              },
            },
          },
          env: { DB: { type: "d1", id: `mytuums_${crypto.randomUUID()}_test` } },
        },
      },
    ],
  });

  try {
    const binding = await runtime.getD1Database("DB", "database-test");
    await migrate(drizzle(binding), {
      migrationsFolder: options?.migrationsFolder ?? committedMigrationsFolder,
    });
    return { db: createDatabase(binding), dispose: () => runtime.dispose() };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}
