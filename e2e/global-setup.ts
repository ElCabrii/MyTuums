import { seedGamesFixture } from "@my-tuums/api/games-fixture";
import { createR2Storage } from "@my-tuums/api/cloudflare-app";
import { truncateAll } from "./support/db.js";
import { closeTestPlatform, testPlatform } from "./support/platform.js";

/** The test server applies migrations before readiness; setup resets and seeds its local bindings. */
export default async function globalSetup(): Promise<void> {
  try {
    await truncateAll();
    const { db, bucket } = await testPlatform();
    await seedGamesFixture({ db, storage: createR2Storage(bucket) });
  } finally {
    await closeTestPlatform();
  }
}
