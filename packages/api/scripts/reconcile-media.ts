/**
 * Reconciles the media bucket against the `user` table.
 *
 * Uploads leave orphans on failure paths the app deliberately tolerates — a
 * failed row write after the objects were stored, a swallowed delete error
 * (see packages/api/src/users.ts). This script is the reaper: it lists every
 * object under `avatars/`, `banners/`, and `posts/`, then deletes keys no
 * profile, post-attachment or link-card row references. This also reaps
 * objects left behind when a hard account delete cascades its post rows, and
 * the previous lead image of a link card whose revalidation race lost the
 * row's upsert.
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
import { linkCard, postAttachment, user } from "@my-tuums/db/schema";
import { reconcileMedia } from "../src/reconcile-media.ts";
import { withPostMediaLifecycleLock } from "../src/post-media-lock.ts";
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

const { listed, deleted } = await withPostMediaLifecycleLock(db, async (tx) => {
  // Post creates hold this transaction-scoped lock while their objects and
  // attachment rows become durable. Keeping it through list/read/delete
  // means reconciliation can never delete an object in that write window.
  return reconcileMedia({
    storage,
    readUserRows: () =>
      tx
        .select({
          image: user.image,
          bannerImage: user.bannerImage,
          imageOriginal: user.imageOriginal,
          bannerImageOriginal: user.bannerImageOriginal,
        })
        .from(user),
    readPostAttachmentRows: () =>
      tx.select({ mediaPath: postAttachment.mediaPath }).from(postAttachment),
    readLinkCardRows: () => tx.select({ imageMediaPath: linkCard.imageMediaPath }).from(linkCard),
  });
});

console.log(`done: listed ${listed}, deleted ${deleted}, kept ${listed - deleted}`);

await closeDb();
