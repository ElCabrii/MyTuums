import { Miniflare } from "miniflare";
import { migrate } from "drizzle-orm/d1/migrator";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/d1";
import { createDatabase } from "../index.js";

/** Ephemeral workerd database: no production credentials, remote bindings or persistent path. */
export async function createTestDatabase() {
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
      migrationsFolder: fileURLToPath(new URL("../../drizzle-d1", import.meta.url)),
    });
    return { db: createDatabase(binding), dispose: () => runtime.dispose() };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}
