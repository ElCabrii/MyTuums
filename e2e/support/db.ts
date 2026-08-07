import { and, desc, eq, like, sql } from "drizzle-orm";
import { assertTestDatabase, databaseNameOf, resolveTestDatabaseUrl } from "@my-tuums/db/testing";
import { E2E } from "../playwright.config";

/**
 * Same fix-up `global-setup.ts` needs, for the same reason: `@my-tuums/db`
 * reads `DATABASE_URL` at module scope, and `dotenv -e ../.env` has already
 * put the *dev* database's URL there by the time this module is first
 * imported in a worker process.
 *
 * Guarded rather than a bare re-assignment, unlike global-setup.ts: this file
 * is imported from worker processes, and it is genuinely unclear whether a
 * worker inherits the mutation global-setup.ts made in the main Playwright
 * process (Node's `child_process.fork` copies `process.env` at fork time, and
 * global setup finishes before workers are spawned — but that's an
 * implementation detail of the runner, not a contract). If it *did* inherit
 * an already-`_test` URL, calling `resolveTestDatabaseUrl()` again would
 * derive `..._test_test` instead of leaving it alone.
 */
function ensureTestDatabaseUrl(): void {
  const current = process.env.DATABASE_URL;
  if (current && databaseNameOf(current).endsWith("_test")) return;
  process.env.DATABASE_URL = resolveTestDatabaseUrl();
}
ensureTestDatabaseUrl();

// Dynamic, for the same reason as global-setup.ts: a static `import` is
// hoisted above the assignment above and would evaluate @my-tuums/db's
// module-scope `DATABASE_URL` check against the wrong value. Both promises
// are created once per worker process and every helper below awaits the same
// cached one.
const dbModulePromise = import("@my-tuums/db");
const schemaModulePromise = import("@my-tuums/db/schema");

async function getDb() {
  return (await dbModulePromise).db;
}

/**
 * Creates a real account through BetterAuth (password hashing, the `account`
 * row, username normalisation) rather than an `insert(user)` — a direct
 * insert would skip all of that and produce a user nothing could sign in as.
 * Hits the server's HTTP endpoint directly rather than importing
 * `@my-tuums/auth`: that package also reads `DATABASE_URL` at module scope
 * (via its own `@my-tuums/db` import), which would mean a second `ensureTestDatabaseUrl`-style
 * dance for no benefit — the server process this suite already boots is
 * right there.
 *
 * No cookies are kept; seeded users besides alice/bob never need a browser
 * session; only their id and normalised handle.
 */
export interface CreateUserInput {
  username: string;
  name: string;
  email: string;
  password: string;
  /** "YYYY-MM-DD" — the web form sends the ISO form, the server stores the date. */
  dateOfBirth: string;
}

/**
 * A user as `createUser` returns it — id, the normalised and display
 * username pair, display name, and email.
 */
export interface CreatedUser {
  id: string;
  username: string;
  displayUsername: string;
  name: string;
  email: string;
}

export async function createUser(input: CreateUserInput): Promise<CreatedUser> {
  const response = await fetch(`${E2E.serverUrl}/api/auth/sign-up/email`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // BetterAuth's CSRF check (formCsrfMiddleware, in its sign-up/email
      // route) rejects a POST whose Origin is missing OR the literal string
      // "null" — and Node's built-in `fetch` sends exactly `Origin: null` on
      // a cross-context POST with no browsing origin behind it, which is
      // this call precisely. `E2E.webUrl` is the one origin the server
      // actually trusts (WEB_ORIGIN in playwright.config.ts's `stackEnv`).
      Origin: E2E.webUrl,
    },
    body: JSON.stringify({
      ...input,
      // The ISO form the web form sends (dateOfBirthToIso in the web app) —
      // same contract, so the server stores the same instant either way.
      dateOfBirth: `${input.dateOfBirth}T00:00:00.000Z`,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `createUser("${input.username}") failed: ${String(response.status)} ${await response.text()}`,
    );
  }

  const body = (await response.json()) as { user: CreatedUser };
  return body.user;
}

/**
 * Nulls out a user's handle, reproducing what an OAuth sign-up leaves behind.
 *
 * The `username` plugin does not populate `user.username` on social sign-up and
 * offers no way to generate one, so a Google/Discord/Twitch account lands in
 * exactly this state — and this app keys every profile URL, follow list and
 * `user.byUsername` lookup on that column. A real OAuth round trip cannot run
 * in this suite (it would need Google's consent screen and live credentials),
 * so the state is produced directly. That is honest: what `/welcome` guards
 * against is the *column being null*, not the provider that made it so.
 *
 * `displayUsername` goes too — `handleOf` falls back to it, so leaving it set
 * would produce a session the gate correctly considers complete.
 */
export async function clearUsername(userId: string): Promise<void> {
  assertTestDatabase();
  const db = await getDb();
  const { user } = await schemaModulePromise;

  await db.update(user).set({ username: null, displayUsername: null }).where(eq(user.id, userId));
}

/**
 * Nulls out a user's date of birth, reproducing the state of an account that
 * predates the 15+ rule (or a social sign-up that skipped it) — the state the
 * /welcome gate holds at the page until a declaration is made. Same shape as
 * `clearUsername`: the gate guards the *column being null*, not how it got
 * that way.
 */
export async function clearDateOfBirth(userId: string): Promise<void> {
  assertTestDatabase();
  const db = await getDb();
  const { user } = await schemaModulePromise;

  await db.update(user).set({ dateOfBirth: null }).where(eq(user.id, userId));
}

/** A post as the seeding helpers return it — id, content, and the explicit createdAt they were inserted with. */
export interface SeededPost {
  id: string;
  content: string;
  createdAt: Date;
}

/**
 * Resolves an already-registered user's id from their normalised username.
 *
 * Alice and bob are created once, in `auth.setup.ts`, via HTTP rather than
 * this module — so specs that want to seed posts/follows/likes "as" one of
 * them (every other helper below takes an id, not a handle) need a way back
 * to the id. Matches on the normalised column, same as `user.byUsername` on
 * the server (packages/api/src/users.ts) — `/@AlexMercer` and `/@alexmercer`
 * must resolve the same user.
 */
export async function getUserId(username: string): Promise<string> {
  const db = await getDb();
  const { user } = await schemaModulePromise;

  const [found] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.username, username.toLowerCase()))
    .limit(1);

  if (!found) throw new Error(`getUserId: no user with username "${username}".`);
  return found.id;
}

/**
 * Reads the newest password-reset token minted for a user — the identifier's
 * `reset-password:` suffix, the same shape the endpoint writes (value = user
 * id). The prefix filter is not optional: sign-up's verification email writes
 * `verification` rows too.
 *
 * The E2E stack runs as `development` with no `RESEND_API_KEY`, so the
 * `[auth:email]` console line in the server's stdout carries the same reset
 * URL — but server output is not programmatically readable from a spec, and
 * the DB is.
 */
export async function passwordResetTokenFor(userId: string): Promise<string> {
  assertTestDatabase();
  const db = await getDb();
  const { verification } = await schemaModulePromise;

  const [row] = await db
    .select({ identifier: verification.identifier })
    .from(verification)
    .where(and(like(verification.identifier, "reset-password:%"), eq(verification.value, userId)))
    .orderBy(desc(verification.createdAt))
    .limit(1);

  if (!row) throw new Error(`passwordResetTokenFor: no reset token for user "${userId}".`);
  return row.identifier.replace("reset-password:", "");
}

/**
 * Inserts `count` top-level posts by `authorId`, newest last.
 *
 * `createdAt` is set explicitly, one millisecond apart, rather than left to
 * the column's `defaultNow()`: Postgres evaluates `now()` once per
 * *statement*, not once per row, so a single multi-row `insert(...).values([...])`
 * would otherwise give every row in the batch the exact same timestamp. The
 * app tolerates that fine (the id tiebreaker in `post_created_idx` still
 * makes the ordering total), but distinct timestamps make "seed N posts,
 * assert they render newest-first" assertions straightforward instead of
 * depending on insertion order lining up with id ordering by coincidence.
 */
export async function seedPosts(
  authorId: string,
  count: number,
  opts?: { content?: (index: number) => string },
): Promise<SeededPost[]> {
  const db = await getDb();
  const { post } = await schemaModulePromise;
  const content = opts?.content ?? ((index: number) => `Seeded post ${String(index + 1)}`);
  const base = Date.now();

  const rows = Array.from({ length: count }, (_, index) => ({
    authorId,
    content: content(index),
    createdAt: new Date(base + index),
  }));

  return db
    .insert(post)
    .values(rows)
    .returning({ id: post.id, content: post.content, createdAt: post.createdAt });
}

/** Inserts a single reply. Returns enough to chain another `seedReply` off it. */
export async function seedReply(
  authorId: string,
  parentId: string,
  content: string,
): Promise<SeededPost> {
  const db = await getDb();
  const { post } = await schemaModulePromise;

  const [created] = await db
    .insert(post)
    .values({ authorId, parentId, content })
    .returning({ id: post.id, content: post.content, createdAt: post.createdAt });

  if (!created) throw new Error("seedReply: insert returned no row.");
  return created;
}

/** Inserts a follow row directly — the composite PK makes this idempotent. */
export async function seedFollow(followerId: string, followingId: string): Promise<void> {
  const db = await getDb();
  const { follow } = await schemaModulePromise;
  await db.insert(follow).values({ followerId, followingId }).onConflictDoNothing();
}

/** Inserts a like row directly — the composite PK makes this idempotent. */
export async function seedLike(postId: string, userId: string): Promise<void> {
  const db = await getDb();
  const { postLike } = await schemaModulePromise;
  await db.insert(postLike).values({ postId, userId }).onConflictDoNothing();
}

/**
 * Sets a user's role directly in the database.
 *
 * The admin plugin's own endpoints are 404'd in the request handler
 * (apps/server/src/request-handler.ts), so the only way a spec gets a
 * moderator fixture is the same row update `pnpm db:promote` performs. The
 * role lands on the next `getSession` — the app runs no session cookie cache,
 * so a fixture promoted at sign-up time carries the role from its first
 * browser request.
 */
export async function setUserRole(
  userId: string,
  role: "user" | "moderator" | "staff" | "admin",
): Promise<void> {
  assertTestDatabase();
  const db = await getDb();
  const { user } = await schemaModulePromise;

  await db.update(user).set({ role }).where(eq(user.id, userId));
}

/**
 * Empties every table and purges the suite's uploaded bucket objects.
 * `global-setup.ts` calls this once at the start of every run; a spec can
 * also call it directly for a guaranteed-clean slate of its own rather than
 * trusting no earlier spec left state behind (workers are pinned to 1, so
 * specs do share one database — see playwright.config.ts).
 * The list is explicit — the same fourteen tables the API harness truncates
 * (`packages/api/src/testing/harness.ts`) — and not a thinner `user`-only
 * `cascade` version. Most moderation tables would be reached through the
 * `user` foreign keys anyway, but `moderation_action.target_post_id` and
 * `target_user_id` deliberately have NO foreign keys, so cascade-only
 * reachability is one schema tweak away from silently leaking rows between
 * specs (issue #59).
 */
export async function truncateAll(): Promise<void> {
  assertTestDatabase();
  const db = await getDb();
  const schema = await schemaModulePromise;

  await db.execute(sql`
    truncate table
      ${schema.postLike}, ${schema.follow}, ${schema.report},
      ${schema.userBlock}, ${schema.appeal}, ${schema.moderationAction},
      ${schema.post},
      ${schema.session}, ${schema.account}, ${schema.verification},
      ${schema.rateLimit}, ${schema.twoFactor}, ${schema.passkey},
      ${schema.user}
    cascade
  `);

  await purgeUploadedImages();
}

/**
 * Deletes every object the suite uploaded to the Storage Bucket.
 *
 * Unlike every other cleanup here, this reaches outside Postgres — objects live
 * in a bucket and a `truncate` cannot touch them, so without this each E2E run
 * leaves its avatars behind permanently and the bill grows one test run at a
 * time.
 *
 * Deliberately best-effort: an unreachable bucket, or a run with no `S3_*`
 * group configured at all, must not fail a suite whose subject was the
 * database. The upload specs are skipped in that configuration anyway (the
 * procedure reports NOT_IMPLEMENTED), so there is nothing to clean.
 *
 * **This is why the E2E bucket must not be the production one.** It deletes by
 * prefix, unconditionally — pointed at production it would delete real users'
 * avatars. See the warning in `.env.example`.
 */
async function purgeUploadedImages(): Promise<void> {
  if (!process.env.S3_ENDPOINT || !process.env.S3_BUCKET) return;

  try {
    // The destructive factory, on purpose: `removeByPrefix` lives only on
    // `DestructiveStorage`, and only this cleanup may reach it. `createStorage`
    // returns plain `Storage` — no procedures, and no other caller, can even
    // name the method.
    const { createDestructiveStorage } = await import("@my-tuums/api/storage");
    const storage = createDestructiveStorage({
      endpoint: process.env.S3_ENDPOINT,
      bucket: process.env.S3_BUCKET,
      accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "",
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "",
      region: process.env.S3_REGION,
    });

    await Promise.all([storage.removeByPrefix("avatars/"), storage.removeByPrefix("banners/")]);
  } catch (error) {
    console.warn("Could not purge uploaded test images from the bucket:", error);
  }
}
