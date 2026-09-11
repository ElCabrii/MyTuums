import { pingDb } from "../src/index.js";
import { createTestDatabase } from "../src/testing/d1.js";

// Integration files create their own ephemeral bindings. This preflight checks
// that the local workerd runtime can apply the committed migrations; it never
// resolves a remote database, loads .env or resets shared development state.
try {
  const database = await createTestDatabase();
  try {
    await pingDb(database.db);
    console.log("Ephemeral D1 test database and committed migrations verified.");
  } finally {
    await database.dispose();
  }
} catch {
  console.error(
    "D1 test database setup failed. Check the local workerd runtime and committed migrations.",
  );
  process.exitCode = 1;
}
