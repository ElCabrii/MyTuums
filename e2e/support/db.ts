import { eq, sql } from "drizzle-orm";
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
}

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
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    throw new Error(
      `createUser("${input.username}") failed: ${String(response.status)} ${await response.text()}`,
    );
  }

  const body = (await response.json()) as { user: CreatedUser };
  return body.user;
}

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
 * Empties every table. `global-setup.ts` already does this once for the
 * whole run; this is for a spec that wants a guaranteed-clean slate of its
 * own rather than trusting no earlier spec left state behind (workers are
 * pinned to 1, so specs do share one database — see playwright.config.ts).
 */
export async function truncateAll(): Promise<void> {
  assertTestDatabase();
  const db = await getDb();
  const schema = await schemaModulePromise;

  await db.execute(sql`
    truncate table
      ${schema.postLike}, ${schema.follow}, ${schema.post},
      ${schema.session}, ${schema.account}, ${schema.verification},
      ${schema.rateLimit}, ${schema.user}
    cascade
  `);
}
