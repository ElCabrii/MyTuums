/**
 * The profile-media lifecycle: replace or remove one user's avatar or banner.
 *
 * Everything a caller has to know to safely change a profile image — storage
 * availability, the display/original object pair, validation, the write
 * ordering, the row lock, the atomic database swap and the best-effort
 * cleanup of superseded objects — lives here. Procedures express *what* they
 * want (`replace`, `remove`) and this module owns *how*.
 *
 * The deletion test: delete this module and the ordering and failure-recovery
 * knowledge would have to move back into both `user.uploadImage` and
 * `user.removeImage` — plus every future writer of these columns.
 *
 * Validation and storage access stay in their own modules on purpose:
 * `acceptImage` (./image.ts) owns the trust rules for untrusted bytes, and
 * `Storage` (./storage.ts) owns the bucket. Neither is duplicated here.
 */

import { randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/server";
import type { Database } from "@my-tuums/db";
import { eq } from "drizzle-orm";
import { user } from "@my-tuums/db/schema";
import type { AllowedImageType, ImageKind } from "./constants.js";
import { imageObjectKey, mediaPathFor, objectKeyFromMediaPath } from "./image.js";
import type { Storage } from "./storage.js";

/**
 * The database surface this module needs: a bare handle or a transaction.
 *
 * Drizzle's transaction type inherits the query builders but not the
 * driver's `$client`, so it is not assignable to `Database` — the same
 * narrowing `moderation-actions.ts` makes for its effects, so the same
 * helpers serve both `db` and a caller's `tx` with no casts.
 */
type DbLike = Pick<Database, "transaction">;

/** The two stored paths one slot held before a swap — `null` when never set. */
interface PreviousPair {
  display: string | null;
  original: string | null;
}

/**
 * Narrowing the injected storage: a deployment with no `S3_*` group is a
 * supported configuration (see context.ts), so this is a runtime state to
 * report rather than an invariant to assert. `NOT_IMPLEMENTED` rather than
 * `INTERNAL_SERVER_ERROR` because nothing is broken — the feature simply
 * isn't configured here, and saying so is more useful than a 500 that looks
 * like a bug.
 */
export function requireStorage(context: { storage: Storage | null }): Storage {
  if (!context.storage) {
    throw new ORPCError("NOT_IMPLEMENTED", {
      message: "Image uploads aren't configured on this server.",
    });
  }
  return context.storage;
}

/**
 * Atomically points one slot's two columns at new values, under a row lock,
 * and hands back what they held before.
 *
 * The avatar/banner pair-key mapping lives here — a replace and a remove
 * share it, and no caller names a column. The lock is not ceremony. The
 * previous values cannot come from `RETURNING` — that reports the row
 * *after* the update — so they have to be read first, and two bare
 * statements would race: two uploads landing together could both read the
 * same old keys, and each would then delete them after its own swap — the
 * pair the first to commit wrote is left orphaned, its row reference
 * overwritten by the second, until the reconciliation script reaps it. The
 * row lock makes the read-then-write one step, so the second swap observes
 * the first's committed pair and deletes THAT instead — the leak never
 * happens.
 *
 * Returns `null` when no such user exists — nothing was written, and
 * whatever was prepared before the swap is left for reconciliation.
 */
async function swapImageColumns(
  db: DbLike,
  userId: string,
  kind: ImageKind,
  values: { display: string | null; original: string | null },
): Promise<PreviousPair | null> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({
        image: user.image,
        bannerImage: user.bannerImage,
        imageOriginal: user.imageOriginal,
        bannerImageOriginal: user.bannerImageOriginal,
      })
      .from(user)
      .where(eq(user.id, userId))
      .for("update")
      .limit(1);

    if (!current) return null;

    await tx
      .update(user)
      .set(
        kind === "avatar"
          ? { image: values.display, imageOriginal: values.original }
          : { bannerImage: values.display, bannerImageOriginal: values.original },
      )
      .where(eq(user.id, userId));

    return kind === "avatar"
      ? { display: current.image, original: current.imageOriginal }
      : { display: current.bannerImage, original: current.bannerImageOriginal };
  });
}

/**
 * Best-effort deletion of the objects behind stored paths, when they were
 * ours. A failure is swallowed on purpose — the user's profile is already
 * correct, and turning a successful replace into an error because a stale
 * object could not be reaped would be the wrong trade. The cost is that
 * objects leak on the paths where the row write fails after the objects are
 * stored, or where this delete errors; `scripts/reconcile-media.mjs` is the
 * reaper, and its existence is part of why swallowing here is safe.
 */
async function discardPrevious(storage: Storage, previous: PreviousPair | null): Promise<void> {
  if (!previous) return;
  for (const value of [previous.display, previous.original]) {
    const key = objectKeyFromMediaPath(value);
    if (!key) continue;
    try {
      await storage.remove(key);
    } catch (error) {
      console.error("Failed to delete replaced image object", key, error);
    }
  }
}

export interface ReplaceInput {
  kind: ImageKind;
  /** The bytes for the display object — the one feeds and profiles render. */
  displayBytes: Uint8Array;
  displayType: AllowedImageType;
  /** The user's untouched original file. */
  originalBytes: Uint8Array;
  originalType: AllowedImageType;
}

export interface ReplaceResult {
  kind: ImageKind;
  url: string;
  originalUrl: string;
}

/**
 * Replaces one slot's pair of objects and repoints the columns at them.
 *
 * The lifecycle — in order:
 *
 * 1. **Prepare.** Keys are minted from the caller's id (never from caller
 *    input — see `imageObjectKey`), and the new bytes are written to the
 *    bucket. A failure here throws BEFORE anything else happened: nothing
 *    was written to the database and the profile is untouched. A
 *    second-object failure leaves one orphaned object behind — the row
 *    never pointed at it, and the reconciliation module reaps it.
 * 2. **Swap.** The row's columns move to the new paths in one locked
 *    transaction. If THAT transaction aborts, the row still points at the
 *    old pair — the profile renders correctly — and the freshly written
 *    objects are orphans for reconciliation, exactly like step 1's failure.
 *    Only the committed row swap makes them current.
 * 3. **Discard.** After the commit, the superseded pair is deleted
 *    best-effort. Deleting before the swap could blank a profile on a
 *    failed update; this module never deletes the pair it just committed.
 *
 * The swap's transaction is the outermost one, always: production callers
 * pass the bare `db` handle, so the row update and the cleanup that follows
 * it share the same commit point. Wrapping the lifecycle in a caller-owned
 * transaction that later aborts is the caller's hazard to own — the row swap
 * would be discarded while the already-executed cleanup is not (see
 * `profile-media.int.test.ts`).
 *
 * The session — not the keys — is what decides whose row is touched; callers
 * pass the session user's id, which is how a client cannot write another
 * user's row through this surface.
 */
export async function replaceProfileMedia(
  db: DbLike,
  storage: Storage,
  userId: string,
  input: ReplaceInput,
): Promise<ReplaceResult> {
  // The types carried here are the sniffed ones from `acceptImage`, which is
  // what gets stored — never the declared type (see ./image.ts).
  const id = randomUUID();
  const displayKey = imageObjectKey(input.kind, userId, input.displayType, "display", id);
  const originalKey = imageObjectKey(input.kind, userId, input.originalType, "original", id);

  await storage.put(displayKey, input.displayBytes, input.displayType);
  await storage.put(originalKey, input.originalBytes, input.originalType);

  const previous = await swapImageColumns(db, userId, input.kind, {
    display: mediaPathFor(displayKey),
    original: mediaPathFor(originalKey),
  });

  // After the row points at the new objects, never before.
  await discardPrevious(storage, previous);

  return {
    kind: input.kind,
    url: mediaPathFor(displayKey),
    originalUrl: mediaPathFor(originalKey),
  };
}

export interface RemoveResult {
  kind: ImageKind;
  url: null;
}

/**
 * Clears one slot and deletes the objects behind it, if they were ours.
 *
 * Same lifecycle as {@link replaceProfileMedia}, minus the prepare: the swap
 * writes nulls, then the superseded pair is discarded best-effort. Clearing
 * a slot that was never set is a legitimate no-op, and an OAuth provider's
 * absolute avatar URL is never deleted (`objectKeyFromMediaPath` returns
 * `null` for it).
 */
export async function removeProfileMedia(
  db: DbLike,
  storage: Storage,
  userId: string,
  kind: ImageKind,
): Promise<RemoveResult> {
  const previous = await swapImageColumns(db, userId, kind, {
    display: null,
    original: null,
  });
  await discardPrevious(storage, previous);

  return { kind, url: null };
}
