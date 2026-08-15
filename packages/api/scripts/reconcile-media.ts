/**
 * Reconciles the media bucket against the `user` table.
 *
 * Uploads leave orphans on failure paths the app deliberately tolerates — a
 * failed row write after the objects were stored, a swallowed delete error
 * (see packages/api/src/users.ts). This script is the reaper: it lists every
 * object under `avatars/` and `banners/` and deletes the keys no user row
 * references.
 *
 * THE GUARD IS THE POINT. A wrong bucket here means deleting real users'
 * avatars, so the script refuses to run unless it is pointed at the bucket
 * EXPLICITLY, by name:
 *
 *   pnpm --filter @my-tuums/api reconcile:media --bucket my-bucket-xxxxxxxx
 *
 * and that name must match `S3_BUCKET` in the environment. Nothing in the
 * environment alone is enough to arm it — the same instinct as
 * `assertTestDatabase()` in @my-tuums/db/testing, which refuses to run
 * against anything but a `_test` database.
 *
 * The reconcile logic itself — the list-before-read ordering, which is
 * load-bearing — lives in `src/reconcile-media.ts`, where it is unit-tested.
 * This file is only the guard and the wiring.
 */
import { closeDb, db } from "@my-tuums/db";
import { user } from "@my-tuums/db/schema";
import { reconcileMedia } from "../src/reconcile-media.ts";
import { createDestructiveStorage } from "@my-tuums/api/storage";

const bucketArg = process.argv
  .find((arg) => arg.startsWith("--bucket="))
  ?.slice("--bucket=".length);

if (!bucketArg) {
  console.error("Refusing to run: pass --bucket=<name> (the exact S3_BUCKET value).");
  process.exit(1);
}
if (bucketArg !== process.env.S3_BUCKET) {
  console.error(
    `Refusing to run: --bucket=${bucketArg} does not match S3_BUCKET (${process.env.S3_BUCKET ?? "unset"}).`,
  );
  process.exit(1);
}
if (
  !process.env.S3_ENDPOINT ||
  !process.env.S3_ACCESS_KEY_ID ||
  !process.env.S3_SECRET_ACCESS_KEY
) {
  console.error("Refusing to run: the S3_* group is not fully set in the environment.");
  process.exit(1);
}

const storage = createDestructiveStorage({
  endpoint: process.env.S3_ENDPOINT,
  bucket: process.env.S3_BUCKET,
  accessKeyId: process.env.S3_ACCESS_KEY_ID,
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  region: process.env.S3_REGION,
});

const { listed, deleted } = await reconcileMedia({
  storage,
  readUserRows: () =>
    db
      .select({
        image: user.image,
        bannerImage: user.bannerImage,
        imageOriginal: user.imageOriginal,
        bannerImageOriginal: user.bannerImageOriginal,
      })
      .from(user),
});

console.log(`done: listed ${listed}, deleted ${deleted}, kept ${listed - deleted}`);

await closeDb();
