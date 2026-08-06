/**
 * Shared harness for the `*.int.test.ts` suites in this package.
 *
 * Not a test file itself — every integration suite imports from here rather
 * than hand-rolling a BetterAuth sign-up or a truncate statement, so there is
 * exactly one place that knows how to safely wipe the test database and mint
 * a real session.
 */
import { randomUUID } from "node:crypto";
import { beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import { auth } from "@my-tuums/auth";
import { db } from "@my-tuums/db";
import { assertTestDatabase } from "@my-tuums/db/testing";
import { post, user } from "@my-tuums/db/schema";
import type { Context } from "../context.js";
import { createRateLimiter, type RateLimiter } from "../rate-limit.js";
import type { UserRole } from "../roles.js";
import type { DestructiveStorage, Storage } from "../storage.js";

/**
 * `context.ts` types `Context.session` as `Awaited<ReturnType<typeof
 * auth.api.getSession>>`, which is nullable — a signed-out caller has no
 * session. Tests want the signed-in shape on its own, and deriving it this
 * way (rather than importing a `Session` type from `better-auth` directly)
 * matters: `better-auth` is a dependency of `@my-tuums/auth`, not of this
 * package, so a direct import would resolve at runtime — pnpm hoists it —
 * but not for `tsc`.
 */
export type AuthSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

/**
 * A signed-up test user: their session, and a `Context` already carrying it.
 *
 * `sessionCookie` is the signed value of the `better-auth.session_token`
 * cookie, captured from the sign-up `set-cookie` header. It is NOT the same as
 * `session.session.token` — better-auth issues the cookie as
 * `<token>.<hmac-signature>` (URL-encoded), and `getSession` returns only the
 * token half, which cannot be re-signed client-side. Re-presenting the cookie
 * needs this stored value; see `sessionHeaders`.
 */
export interface TestUser {
  id: string;
  session: AuthSession;
  /** The signed `better-auth.session_token` cookie value from sign-up. */
  sessionCookie: string;
  context: Context;
}

/**
 * Every `*.int.test.ts` file's own rate-limit state, entirely separate from
 * production's (see `context.ts`'s `defaultRateLimiter`) and from every other
 * test file's — Vitest gives each test file a fresh module registry, so this
 * `let` starts over on every file that imports this module.
 *
 * `currentTestRateLimiter` is reassigned — not cleared — in the `beforeEach`
 * below, and `forwardingRateLimiter` is what lets `anonContext` stay a plain,
 * reusable exported object instead of a function every one of its ~50 call
 * sites would need to become: its methods read `currentTestRateLimiter` at
 * CALL time, not at import time, so the same `anonContext` reference
 * transparently gets a fresh budget every test without itself being
 * recreated. `contextFor` gets the same forwarding instance by default for
 * the same reason.
 *
 * Within a single test, every `contextFor(...)`/`anonContext` call still
 * shares one limiter — `beforeEach` only reassigns BETWEEN tests — so a test
 * that deliberately exhausts a budget across several calls (procedures.int.test.ts)
 * keeps working unchanged.
 */
let currentTestRateLimiter = createRateLimiter();

beforeEach(() => {
  currentTestRateLimiter = createRateLimiter();
});

const forwardingRateLimiter: RateLimiter = {
  consume: (key, policy) => currentTestRateLimiter.consume(key, policy),
  clear: () => {
    currentTestRateLimiter.clear();
  },
  get size() {
    return currentTestRateLimiter.size;
  },
};

/**
 * An in-memory stand-in for a Storage Bucket.
 *
 * Integration tests run against real Postgres and the real Better Auth
 * instance, deliberately — but a bucket is where that principle stops paying.
 * It is a network service outside the transaction the truncate helper controls,
 * so objects written by a test would survive it, accumulate, and cost money;
 * and asserting "the row points at the object we stored" needs no S3 at all.
 * `Context.storage` exists as an injectable field precisely so this can be
 * substituted (see the doc comment there).
 *
 * `objects` is exported so a test can assert what was written and deleted.
 * `resetTestStorage()` clears it, and the `beforeEach` above's sibling below
 * calls it, so no file has to remember.
 */
export const testStorageObjects = new Map<string, { contentType: string; bytes: Uint8Array }>();

export const testStorage: DestructiveStorage = {
  put(key, bytes, contentType) {
    testStorageObjects.set(key, { contentType, bytes });
    return Promise.resolve();
  },
  remove(key) {
    testStorageObjects.delete(key);
    return Promise.resolve();
  },
  listByPrefix(prefix) {
    return Promise.resolve([...testStorageObjects.keys()].filter((key) => key.startsWith(prefix)));
  },
  removeMany(keys) {
    for (const key of keys) testStorageObjects.delete(key);
    return Promise.resolve(keys.length);
  },
  removeByPrefix(prefix) {
    let removed = 0;
    for (const key of [...testStorageObjects.keys()]) {
      if (key.startsWith(prefix)) {
        testStorageObjects.delete(key);
        removed += 1;
      }
    }
    return Promise.resolve(removed);
  },
  signedGetUrl(key) {
    return Promise.resolve(`https://storage.test.invalid/${key}?signed=1`);
  },
};

beforeEach(() => {
  testStorageObjects.clear();
});

/**
 * Signs up a brand-new user through real BetterAuth rather than inserting a
 * fixture row by hand, so these tests exercise the same password hashing,
 * cookie issuance, and username normalisation the app relies on in
 * production — and so `context.session` looks exactly like what
 * `createContext` builds from a real request.
 *
 * `randomUUID()` is the source of uniqueness for both the email and the
 * username, so concurrent tests (and repeated runs against a database that
 * wasn't truncated) never collide on BetterAuth's unique constraints.
 */
export async function createTestUser(overrides?: {
  username?: string;
  name?: string;
}): Promise<TestUser> {
  const uuid = randomUUID();
  const email = `vitest+${uuid}@example.com`;
  const username = overrides?.username ?? `vitest${uuid.replace(/-/g, "").slice(0, 8)}`;
  const name = overrides?.name ?? "Vitest User";

  const signUpResult = await auth.api.signUpEmail({
    body: {
      email,
      password: "vitest-Sup3rSecret!",
      name,
      username,
    },
    returnHeaders: true,
  });

  const setCookie = signUpResult.headers.get("set-cookie");
  if (!setCookie) {
    throw new Error(
      "auth.api.signUpEmail() returned no set-cookie header — check that " +
        "emailAndPassword is enabled in packages/auth/src/index.ts.",
    );
  }

  // The session cookie's VALUE is what matters, and it is signed — the raw
  // `set-cookie` string cannot be handed to `Headers` again for `getSession`,
  // and `session.session.token` below only carries the token half. The whole
  // cookie header round-trips fine (the "cookie" header below), so parse the
  // value out once, here, and let `sessionHeaders` re-present it later.
  const sessionCookie = setCookie
    .split(/,(?=\s*[\w.]+=)/)
    .map((part) => part.trim().split(";")[0])
    .find((pair) => pair.startsWith("better-auth.session_token="))
    ?.slice("better-auth.session_token=".length);
  if (!sessionCookie) {
    throw new Error(
      "auth.api.signUpEmail() returned no better-auth.session_token cookie — " +
        "the session cookie name has changed upstream.",
    );
  }

  const session = await auth.api.getSession({ headers: new Headers({ cookie: setCookie }) });
  if (!session) {
    throw new Error(
      "auth.api.getSession() returned null immediately after sign-up — the " +
        "session cookie from signUpEmail didn't round-trip.",
    );
  }

  return {
    id: session.user.id,
    session,
    sessionCookie,
    // Only ever read as `.context.db` for raw drizzle assertions in these
    // tests (not for making rate-limited calls — those go through
    // `contextFor`), so the forwarding limiter is a formality here, not a
    // behaviour anything actually exercises.
    context: { db, session, rateLimiter: forwardingRateLimiter, storage: testStorage },
  };
}

/** The context a signed-out caller gets — what `createContext` builds when there's no session. */
export const anonContext: Context = {
  db,
  session: null,
  rateLimiter: forwardingRateLimiter,
  storage: testStorage,
};

/**
 * A signed-in caller's context, optionally carrying a specific `RateLimiter`
 * instance — a test that wants a budget isolated even from its own file's
 * other tests (rather than the per-test-file default above) can pass its own
 * `createRateLimiter()`.
 */
export function contextFor(
  user: TestUser,
  rateLimiter: RateLimiter = forwardingRateLimiter,
  storage: Storage | null = testStorage,
): Context {
  return { db, session: user.session, rateLimiter, storage };
}

/**
 * Wipes every table these tests touch, in FK-safe order.
 *
 * `assertTestDatabase()` is the guard against this ever running against a
 * real database — every destructive helper in this file calls it first, so a
 * mis-set `DATABASE_URL` fails loudly instead of truncating someone's dev
 * data.
 */
export async function truncateAll(): Promise<void> {
  assertTestDatabase();
  await db.execute(
    sql`TRUNCATE TABLE "post_like", "follow", "report", "user_block", "appeal", "moderation_action", "post", "session", "account", "verification", "rate_limit", "two_factor", "passkey", "user" RESTART IDENTITY CASCADE`,
  );
}

/**
 * Direct drizzle inserts for pagination fixtures — much faster than going
 * through `post.create` for 40+ rows, and it lets a test control `createdAt`
 * precisely, which the API has no way to do at all. That precision is what
 * makes the millisecond-tie tests possible: they need several rows to share
 * an *identical* timestamp, not just a close one.
 *
 * `createdAt` is omitted from a row's insert (rather than passed as
 * `undefined`) when not given, so the column's own `defaultNow()` applies —
 * passing `undefined` explicitly risks drizzle treating the key as present.
 */
export async function seedPosts(
  authorId: string,
  count: number,
  opts: {
    parentId?: string;
    /** A single instant for every row, or a per-row factory. Omit to let the column default apply. */
    createdAt?: Date | ((index: number) => Date);
  } = {},
): Promise<{ id: string; createdAt: Date }[]> {
  if (count <= 0) return [];

  const rows: (typeof post.$inferInsert)[] = Array.from({ length: count }, (_, i) => {
    const row: typeof post.$inferInsert = {
      authorId,
      content: `seed post ${i} ${randomUUID()}`,
    };
    if (opts.parentId) row.parentId = opts.parentId;
    if (opts.createdAt) {
      row.createdAt = typeof opts.createdAt === "function" ? opts.createdAt(i) : opts.createdAt;
    }
    return row;
  });

  return db.insert(post).values(rows).returning({ id: post.id, createdAt: post.createdAt });
}

/**
 * The cookie header that re-presents a session to better-auth — the same
 * `better-auth.session_token` cookie a real browser would send.
 *
 * This MUST use the user's stored `sessionCookie` (the signed value from the
 * original `set-cookie` header), not `session.session.token`: better-auth
 * issues the cookie as `<token>.<hmac-signature>`, and the signature cannot be
 * rebuilt from the token alone. A `TestUser` carries the signed value
 * precisely so a test can re-fetch a session (a role change, a fresh
 * post-suspension read) through the real `getSession` path.
 */
export function sessionHeaders(user: TestUser): Headers {
  return new Headers({ cookie: `better-auth.session_token=${user.sessionCookie}` });
}

/**
 * Re-fetches a user's session through the real `auth.api.getSession`.
 *
 * The app deliberately runs no session cookie cache (packages/auth), so a
 * role or ban change lands on the NEXT `getSession` — this helper is the way
 * a test moves to that next one after mutating the `user` row directly.
 * Throws when the session no longer exists (a suspension deleted it), which
 * is exactly the assertion the suspension tests need to make by hand anyway.
 */
export async function freshSessionFor(testUser: TestUser): Promise<TestUser> {
  const session = await auth.api.getSession({ headers: sessionHeaders(testUser) });
  if (!session) {
    throw new Error("freshSessionFor: getSession returned null — the session no longer exists.");
  }
  return {
    id: testUser.id,
    session,
    // The signed cookie survives unchanged — `getSession` does not rotate the
    // token or its signature, so the same value keeps re-presenting the same
    // session until a suspension deletes the row.
    sessionCookie: testUser.sessionCookie,
    context: { db, session, rateLimiter: forwardingRateLimiter, storage: testStorage },
  };
}

/**
 * Sets a user's role directly in the database.
 *
 * The admin plugin's own `/api/auth/admin/*` endpoints are 404'd
 * (apps/server/src/request-handler.ts) — our role gates are the only surface,
 * and to exercise a moderator gate a test needs a moderator. Promoting
 * through the row is the same path `pnpm db:promote` uses; the new role lands
 * on the next `getSession` (see `freshSessionFor`).
 */
export async function setUserRole(userId: string, role: UserRole): Promise<void> {
  await db.update(user).set({ role }).where(eq(user.id, userId));
}

/**
 * Bans a user directly in the database — `expiresAt` null is a permanent ban,
 * a past date an expired suspension, a future date a live one. The visibility
 * predicate reads the row at query time, so the effect is immediate for any
 * caller; only the `user` row itself changes.
 */
export async function setUserBan(
  userId: string,
  args: { reason: string; expiresAt: Date | null },
): Promise<void> {
  await db
    .update(user)
    .set({ banned: true, banReason: args.reason, banExpires: args.expiresAt })
    .where(eq(user.id, userId));
}
