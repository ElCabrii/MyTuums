import { createHmac } from "node:crypto";
import { and, desc, eq, like, sql } from "drizzle-orm";
import { assertTestDatabase, databaseNameOf, resolveTestDatabaseUrl } from "@my-tuums/db/testing";
import type { UserRole } from "@my-tuums/api/roles";
import { normalizeUsername } from "@my-tuums/auth/rules";
import { E2E } from "../playwright.config";
import { legalConsentBody } from "./users";

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
 * A user as `createUser` returns it — id, the identical canonical username
 * pair, display name, and email.
 */
export interface CreatedUser {
  id: string;
  username: string;
  displayUsername: string;
  name: string;
  email: string;
}

export async function createUser(
  input: CreateUserInput,
  options: { verifyEmail?: boolean } = {},
): Promise<CreatedUser> {
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
      ...legalConsentBody(),
    }),
  });

  if (!response.ok) {
    throw new Error(
      `createUser("${input.username}") failed: ${String(response.status)} ${await response.text()}`,
    );
  }

  // SAFETY: A successful Better Auth sign-up response owns this `user` contract;
  // failures have already been rejected above before the response is consumed.
  const body = (await response.json()) as { user: CreatedUser };

  // With `requireEmailVerification` (packages/auth), a password sign-up creates
  // the account but issues no session until the email is proved. Fixture
  // accounts are meant to be usable — most are signed back in through the real
  // login form (see welcome.spec.ts's `signedInWithoutHandle`), which an
  // unverified account now fails — so this grandfathers each one the same way
  // the `0014_grandfather_email_verified` migration grandfathered every real
  // account. A spec that needs the pending state passes `{ verifyEmail: false }`
  // and leaves the column alone.
  if (options.verifyEmail ?? true) {
    await markEmailVerified(body.user.id);
  }

  return body.user;
}

/**
 * Marks a user's email verified directly, reproducing what a clicked
 * verification link does — the same grandfathering the
 * `0014_grandfather_email_verified` migration applied to every real account.
 *
 * With `requireEmailVerification` (packages/auth), a password sign-up creates
 * the account but issues no session until the email is proved. `createUser`
 * calls this by default so fixture accounts can sign in; a spec that needs the
 * pending, unverified state creates the account with `{ verifyEmail: false }`
 * and later calls this to simulate the verification link being clicked.
 */
export async function markEmailVerified(userId: string): Promise<void> {
  assertTestDatabase();
  const db = await getDb();
  const { user } = await schemaModulePromise;

  await db.update(user).set({ emailVerified: true }).where(eq(user.id, userId));
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

/**
 * Nulls out a user's recorded legal consent, reproducing an OAuth or passkey
 * sign-up — neither has anywhere to present the acceptance box, so those
 * accounts land with both columns null (issue #157). Accounts created before
 * the record existed have the same shape.
 *
 * Same honesty as `clearUsername`: a real provider round trip cannot run in
 * this suite, and what the gate gets asked about is the *columns being
 * unset*, not the path that left them that way.
 */
export async function clearLegalConsent(userId: string): Promise<void> {
  assertTestDatabase();
  const db = await getDb();
  const { user } = await schemaModulePromise;

  await db
    .update(user)
    .set({ legalAcceptedAt: null, legalVersion: null })
    .where(eq(user.id, userId));
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
    .where(eq(user.username, normalizeUsername(username)))
    .limit(1);

  if (!found) throw new Error(`getUserId: no user with username "${username}".`);
  return found.id;
}

/**
 * Builds the verification URL a real verification email would carry, signed
 * with the same secret the server signs them with — so a browser visiting it
 * is verified exactly as if they had clicked the link in their inbox.
 *
 * Unlike `passwordResetTokenFor`, the email-verification token is NOT in the
 * `verification` table: Better Auth mints it as a stateless HS256 JWT (header
 * `{ alg: "HS256" }`, payload `{ email, iat, exp }`) signed with
 * `auth.$context.secret`, so there is no row to read. The E2E stack has no
 * mailbox, and the server's stdout (where the blank-`RESEND_API_KEY` fallback
 * logs the link) is not readable from a spec, so the token is re-minted here
 * with the same secret the server resolved — `BETTER_AUTH_SECRET`, or the E2E
 * fallback default in playwright.config.ts which the worker process inherits
 * (it forks from the main process that loaded the repo `.env`).
 *
 * Mirrors `signVerificationJwt` in packages/api/src/auth.int.test.ts rather
 * than sharing it: the integration test resolves the secret from
 * `auth.$context` (it can import `@my-tuums/auth`), while a worker spec cannot
 * do the module-scope `DATABASE_URL` dance that import would trigger (see
 * `createUser`). The expression below matches what create-context.mjs sets.
 */
export function emailVerificationLinkFor(email: string, callbackURL: string): string {
  const secret = process.env.BETTER_AUTH_SECRET ?? "playwright-e2e-secret-at-least-32-characters";
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({ email: email.toLowerCase(), iat: now, exp: now + 3600 }),
  ).toString("base64url");
  const data = `${header}.${payload}`;
  const signature = createHmac("sha256", secret).update(data).digest("base64url");
  const token = `${data}.${signature}`;
  return `${E2E.serverUrl}/api/auth/verify-email?token=${token}&callbackURL=${encodeURIComponent(callbackURL)}`;
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
 * Inserts a report row directly — the composite PK (reporter, target) makes
 * this idempotent, the same way `seedFollow` and `seedLike` are.
 *
 * The alternative is driving the report dialog, which the moderation journey
 * already covers end to end; a spec that only needs a case sitting in the
 * queue (the accessibility scan) should not pay for that walk.
 */
export async function seedReport(input: {
  reporterId: string;
  targetType: "post" | "user";
  targetId: string;
  reason: string;
}): Promise<void> {
  const db = await getDb();
  const { report } = await schemaModulePromise;
  await db.insert(report).values(input).onConflictDoNothing();
}

/**
 * Deletes one seeded report — the inverse of {@link seedReport}.
 *
 * Specs share one database (`workers: 1`, and only global setup truncates),
 * so a spec that seeds an open report leaves a case sitting in every later
 * spec's queue — including the moderation journey, which asserts the queue
 * drains to empty. A spec that seeds a case cleans it up.
 */
export async function deleteReport(input: {
  reporterId: string;
  targetType: "post" | "user";
  targetId: string;
}): Promise<void> {
  assertTestDatabase();
  const db = await getDb();
  const { report } = await schemaModulePromise;
  await db
    .delete(report)
    .where(
      and(
        eq(report.reporterId, input.reporterId),
        eq(report.targetType, input.targetType),
        eq(report.targetId, input.targetId),
      ),
    );
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
export async function setUserRole(userId: string, role: UserRole): Promise<void> {
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
 * The list is explicit — the same fifteen tables the API harness truncates
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
      ${schema.notification},
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

    await Promise.all([
      storage.removeByPrefix("avatars/"),
      storage.removeByPrefix("banners/"),
      storage.removeByPrefix("posts/"),
    ]);
  } catch (error) {
    console.warn("Could not purge uploaded test images from the bucket:", error);
  }
}
