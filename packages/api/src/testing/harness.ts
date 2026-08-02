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
import { sql } from "drizzle-orm";
import { auth } from "@my-tuums/auth";
import { db } from "@my-tuums/db";
import { assertTestDatabase } from "@my-tuums/db/testing";
import { post } from "@my-tuums/db/schema";
import type { Context } from "../context.js";
import { createRateLimiter, type RateLimiter } from "../rate-limit.js";

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

export interface TestUser {
  id: string;
  session: AuthSession;
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
    // Only ever read as `.context.db` for raw drizzle assertions in these
    // tests (not for making rate-limited calls — those go through
    // `contextFor`), so the forwarding limiter is a formality here, not a
    // behaviour anything actually exercises.
    context: { db, session, rateLimiter: forwardingRateLimiter },
  };
}

/** The context a signed-out caller gets — what `createContext` builds when there's no session. */
export const anonContext: Context = { db, session: null, rateLimiter: forwardingRateLimiter };

/**
 * A signed-in caller's context, optionally carrying the IP the rate limiter
 * would see and/or a specific `RateLimiter` instance — a test that wants a
 * budget isolated even from its own file's other tests (rather than the
 * per-test-file default above) can pass its own `createRateLimiter()`.
 */
export function contextFor(
  user: TestUser,
  clientIp?: string,
  rateLimiter: RateLimiter = forwardingRateLimiter,
): Context {
  return { db, session: user.session, clientIp, rateLimiter };
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
    sql`TRUNCATE TABLE "post_like", "follow", "post", "session", "account", "verification", "rate_limit", "user" RESTART IDENTITY CASCADE`,
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
