/**
 * Shared harness for the `*.int.test.ts` suites in this package.
 *
 * Not a test file itself — every integration suite imports from here rather
 * than hand-rolling a BetterAuth sign-up or a truncate statement, so there is
 * exactly one place that knows how to safely wipe the test database and mint
 * a real session.
 */
import { randomUUID } from "node:crypto";
import { beforeEach, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { auth } from "@my-tuums/auth";
import { db } from "@my-tuums/db";
import { assertTestDatabase } from "@my-tuums/db/testing";
import { testHelpers } from "@my-tuums/auth/testing";
import { post, user } from "@my-tuums/db/schema";
import { LEGAL_VERSION } from "@my-tuums/auth/rules";
import type { Context, EmailSender } from "../context.js";
import { createLinkFetchTransport } from "../link-card-http.js";
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
 * cookie, captured when the session was minted. It is NOT the same as
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
 * The real link-card transport, shared by every harness-built context: only
 * `link-card.int.test.ts` overrides it (with a fake network), and that suite
 * builds its contexts by hand for exactly that reason.
 */
const defaultTestLinkTransport = createLinkFetchTransport();

/** Recording email adapter shared by integration-test contexts. */
export const testEmailSender: EmailSender = {
  send: vi.fn(() => Promise.resolve()),
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
    for (const key of testStorageObjects.keys()) {
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
  vi.mocked(testEmailSender.send).mockReset().mockResolvedValue();
});

/**
 * Mints a usable, onboarding-complete fixture account and a real session for
 * it, through `@my-tuums/auth/testing`'s privileged helpers.
 *
 * The session is created by `authTest`, then resolved through the PRODUCTION
 * `auth.api.getSession` — the two instances share `BETTER_AUTH_SECRET` and
 * the `session` table, so what lands in `context.session` is byte-for-byte
 * what `createContext` builds from a real request. `auth.int.test.ts` pins
 * that property directly ("mints a session that the production auth instance
 * accepts").
 *
 * It deliberately does NOT go through `signUpEmail` + `signInEmail`. Those
 * two calls cost one scrypt hash each — about 430ms per fixture, and this
 * package creates several hundred of them, which was most of the integration
 * suite's runtime. Nothing outside `auth.int.test.ts` is asserting anything
 * about sign-up: that file exercises the production instance's rules
 * (verification, handle bounds, date of birth, legal consent, password
 * policy) on purpose and must keep doing so, and the browser suite registers
 * real accounts through the real form. Here the account is a premise, not the
 * thing under test.
 *
 * Two consequences worth knowing:
 *
 * - There is no `account` row, because there is no password. A test that
 *   needs to sign in with credentials belongs in `auth.int.test.ts` with the
 *   production instance.
 * - `authTest` carries no `databaseHooks`, so the fixture bypasses the
 *   user-field rules. The handle is still canonicalised — migration
 *   `0015_lowercase_usernames` installs a database trigger that lowercases
 *   `username` and derives `display_username` on every write, whoever the
 *   writer is.
 */
export async function createTestUser(overrides?: {
  username?: string;
  name?: string;
}): Promise<TestUser> {
  const uuid = randomUUID();
  const test = await testHelpers();

  const created = test.createUser({
    email: `vitest+${uuid}@example.com`,
    name: overrides?.name ?? "Vitest User",
    emailVerified: true,
    username: overrides?.username ?? `vitest${uuid.replace(/-/g, "").slice(0, 8)}`,
    // The admin plugin supplies this default on the production instance;
    // `authTest` does not carry that plugin, and a null role is a shape no
    // real account has.
    role: "user",
    // Fixtures are meant to be usable, so they are onboarding-complete:
    // `protectedProcedure` refuses a session with no handle, no date of birth
    // or no current legal consent (hasCompletedOnboarding /
    // hasCurrentLegalConsent in packages/auth/src/rules.ts), and almost every
    // test in this package calls a protected procedure. A test that wants an
    // incomplete account clears the column on the row and re-fetches the
    // session itself (see onboarding-gate.int.test.ts).
    dateOfBirth: new Date("1995-01-01"),
    legalAcceptedAt: new Date(),
    legalVersion: LEGAL_VERSION,
  });
  await test.saveUser(created);

  const { cookies } = await test.login({ userId: created.id });
  const sessionCookie = cookies.find(
    (cookie) => cookie.name === "better-auth.session_token",
  )?.value;
  if (!sessionCookie) {
    throw new Error(
      "authTest.login() returned no better-auth.session_token cookie — " +
        "the session cookie name has changed upstream.",
    );
  }

  const session = await auth.api.getSession({
    headers: new Headers({ cookie: `better-auth.session_token=${sessionCookie}` }),
  });
  if (!session) {
    throw new Error(
      "auth.api.getSession() returned null for a session minted by authTest — " +
        "the two instances no longer share a secret or a session table.",
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
    context: {
      db,
      session,
      requestId: "test-request-id",
      rateLimiter: forwardingRateLimiter,
      storage: testStorage,
      linkTransport: defaultTestLinkTransport,
      emailSender: testEmailSender,
    },
  };
}

/**
 * The expensive fixture: an account with a real credential, created and
 * signed in through the PRODUCTION instance.
 *
 * `createTestUser` above deliberately mints no password, which makes
 * `auth.api.signInEmail` throw for every fixture — vacuously satisfying any
 * "sign-in is refused" assertion. Better Auth's admin plugin enforces a ban
 * at sign-in, not at session resolution (a suspended account's *new* session
 * still resolves), so proving a suspension actually locks an account needs a
 * credential to be refused. That is the only reason to reach for this: two
 * scrypt hashes, about 430ms, versus about 95ms for the ordinary fixture.
 *
 * Returns the account's email and password alongside the usual `TestUser`, so
 * the caller can attempt the sign-in it is asserting about.
 */
export async function createPasswordTestUser(): Promise<
  TestUser & { email: string; password: string }
> {
  const uuid = randomUUID();
  const email = `vitest-pw+${uuid}@example.com`;
  const password = "vitest-Sup3rSecret!";

  await auth.api.signUpEmail({
    body: {
      email,
      password,
      name: "Vitest User",
      username: `vitestpw${uuid.replace(/-/g, "").slice(0, 8)}`,
      dateOfBirth: new Date("1995-01-01"),
      legalAcceptedAt: new Date(),
      legalVersion: LEGAL_VERSION,
    },
  });

  const [created] = await db.select({ id: user.id }).from(user).where(eq(user.email, email));
  if (!created) throw new Error("createPasswordTestUser: signUpEmail created no user row.");
  // requireEmailVerification means sign-up issues no session; fixtures are
  // grandfathered the same way migration 0014 grandfathered real accounts.
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, created.id));

  const signIn = await auth.api.signInEmail({ body: { email, password }, returnHeaders: true });
  const setCookie = signIn.headers.get("set-cookie");
  if (!setCookie) throw new Error("createPasswordTestUser: sign-in returned no set-cookie.");

  // better-auth issues the cookie as `<token>.<hmac>`; the signature cannot be
  // rebuilt from `session.session.token`, so the signed value is parsed out
  // once here and re-presented by `sessionHeaders`.
  const sessionCookie = setCookie
    .split(/,(?=\s*[\w.]+=)/)
    .map((part) => part.trim().split(";")[0])
    .find((pair) => pair.startsWith("better-auth.session_token="))
    ?.slice("better-auth.session_token=".length);
  if (!sessionCookie) throw new Error("createPasswordTestUser: no session_token cookie.");

  const session = await auth.api.getSession({ headers: new Headers({ cookie: setCookie }) });
  if (!session) throw new Error("createPasswordTestUser: the sign-in cookie did not round-trip.");

  return {
    id: session.user.id,
    session,
    sessionCookie,
    email,
    password,
    context: {
      db,
      session,
      requestId: "test-request-id",
      rateLimiter: forwardingRateLimiter,
      storage: testStorage,
      linkTransport: defaultTestLinkTransport,
      emailSender: testEmailSender,
    },
  };
}

/** The context a signed-out caller gets — what `createContext` builds when there's no session. */
export const anonContext: Context = {
  db,
  session: null,
  requestId: "test-request-id",
  rateLimiter: forwardingRateLimiter,
  storage: testStorage,
  linkTransport: defaultTestLinkTransport,
  emailSender: testEmailSender,
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
  emailSender: EmailSender = testEmailSender,
): Context {
  return {
    db,
    session: user.session,
    requestId: "test-request-id",
    rateLimiter,
    storage,
    linkTransport: defaultTestLinkTransport,
    emailSender,
  };
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
    sql`TRUNCATE TABLE "post_like", "post_repost", "post_bookmark", "post_edit", "follow", "report", "user_block", "appeal", "moderation_action", "post", "link_card", "session", "account", "verification", "rate_limit", "two_factor", "passkey", "user" RESTART IDENTITY CASCADE`,
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
      row.createdAt = opts.createdAt instanceof Date ? opts.createdAt : opts.createdAt(i);
    }
    return row;
  });

  const seeded = await db
    .insert(post)
    .values(rows)
    .returning({ id: post.id, createdAt: post.createdAt });

  // The contract every caller destructures against ("give me N posts, get N
  // rows"), refused here rather than guarded at each call site — the e2e
  // specs guard per site because their helper is a different implementation;
  // here one refusal keeps a harness regression from surfacing three lines
  // later as `Cannot read properties of undefined`.
  if (seeded.length !== count) {
    throw new Error(`seedPosts returned ${seeded.length} rows for count ${count}`);
  }
  return seeded;
}

/**
 * The cookie header that re-presents a session to better-auth — the same
 * `better-auth.session_token` cookie a real browser would send.
 *
 * This MUST use the user's stored `sessionCookie` (the signed value captured
 * when the session was minted), not `session.session.token`: better-auth
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
    context: {
      db,
      session,
      requestId: "test-request-id",
      rateLimiter: forwardingRateLimiter,
      storage: testStorage,
      linkTransport: defaultTestLinkTransport,
      emailSender: testEmailSender,
    },
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
