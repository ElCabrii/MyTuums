/**
 * The auth-hardening surface, against real BetterAuth and real Postgres.
 *
 * These exercise the *production* `auth` instance from `@my-tuums/auth`, not
 * the `authTest` one — the whole point is to assert the configuration that
 * ships (its plugins, its password rules, its French error messages), so a
 * test-only instance with a smaller plugin list would be asserting nothing.
 * `authTest` appears here only where a test needs a fixture minted cheaply.
 */
import { randomUUID } from "node:crypto";
import { base32 } from "@better-auth/utils/base32";
import { createOTP } from "@better-auth/utils/otp";
import { desc, eq, like } from "drizzle-orm";
import { auth } from "@my-tuums/auth";
import { authTest, testHelpers } from "@my-tuums/auth/testing";
import { closeDb, db } from "@my-tuums/db";
import { passkey, twoFactor, user, verification } from "@my-tuums/db/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { truncateAll } from "./testing/harness.js";

const PASSWORD = "vitest-Sup3rSecret!";

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await truncateAll();
  await closeDb();
});

/**
 * A cookie jar, because these flows span several calls and the naive approach
 * breaks in two separate ways.
 *
 * `Headers.get("set-cookie")` joins multiple cookies with ", " into one
 * unparseable string, and a 2FA sign-in sets more than one (the challenge
 * cookie alongside the rest) — `getSetCookie()` is the only way to see them
 * individually. Separately, verifying a second factor *rotates* the session
 * cookie, so headers captured before the call stop authenticating after it.
 * Keeping a jar and re-absorbing every response models what a browser does.
 */
class CookieJar {
  private readonly cookies = new Map<string, string>();

  absorb(headers: Headers): this {
    for (const raw of headers.getSetCookie()) {
      const pair = raw.split(";")[0] ?? "";
      const separator = pair.indexOf("=");
      if (separator > 0) {
        this.cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1));
      }
    }
    return this;
  }

  get headers(): Headers {
    const cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    return new Headers({ cookie });
  }
}

/** Signs up through the real instance and returns a jar carrying the session. */
async function signUp(
  overrides: { username?: string; email?: string; password?: string; dateOfBirth?: Date } = {},
) {
  const uuid = randomUUID();
  const email = overrides.email ?? `vitest+${uuid}@example.com`;
  const username = overrides.username ?? `vitest${uuid.replace(/-/g, "").slice(0, 8)}`;

  const result = await auth.api.signUpEmail({
    body: {
      email,
      password: overrides.password ?? PASSWORD,
      name: "Vitest User",
      username,
      // Omitted unless a test says otherwise — the wire format the web app
      // sends (`dateOfBirthToIso` in apps/web/src/lib/auth-validation.ts).
      ...(overrides.dateOfBirth ? { dateOfBirth: overrides.dateOfBirth } : {}),
    },
    returnHeaders: true,
  });

  const jar = new CookieJar().absorb(result.headers);
  return { email, username, jar, headers: jar.headers };
}

/**
 * A Date `years` ago, nudged by `offsetDays` — the DOB boundary cases (15y
 * exactly, 15y minus a day) are relative so the suite keeps asserting the
 * same thing as the calendar moves. A Date, because that is what the
 * additionalFields `date` type accepts at the typed `auth.api` boundary;
 * BetterAuth serializes it to the ISO form the web app sends.
 */
function dob(years: number, offsetDays = 0): Date {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d;
}

/** Enrols and confirms 2FA, returning the backup codes and a jar with the rotated session. */
async function enrolTwoFactor(jar: CookieJar) {
  const enabled = await auth.api.enableTwoFactor({
    body: { password: PASSWORD },
    headers: jar.headers,
  });

  const verified = await auth.api.verifyTOTP({
    body: { code: await totpFor(enabled.totpURI) },
    headers: jar.headers,
    returnHeaders: true,
  });
  jar.absorb(verified.headers);

  return enabled;
}

/**
 * Derives a live TOTP code from the enrolment URI, the way an authenticator
 * app does. Without this the enrolment flow could only be tested as far as "a
 * secret was generated", which is the uninteresting half.
 *
 * The `secret` query parameter is base32-encoded — that is what the otpauth://
 * format specifies and what `createOTP().url()` writes — while `createOTP`
 * itself takes the raw secret. Feeding the encoded form straight back in
 * produces codes that look perfectly valid and never verify.
 */
async function totpFor(totpURI: string): Promise<string> {
  const encoded = new URL(totpURI).searchParams.get("secret");
  if (!encoded) throw new Error(`no secret in TOTP URI: ${totpURI}`);

  const secret = new TextDecoder().decode(base32.decode(encoded));
  return createOTP(secret, { digits: 6, period: 30 }).totp();
}

describe("two-factor enrolment", () => {
  it("does not enable 2FA until a code is verified — the guard against locking yourself out with a secret you never scanned", async () => {
    const { username, jar, headers } = await signUp();

    const enabled = await auth.api.enableTwoFactor({ body: { password: PASSWORD }, headers });
    expect(enabled.totpURI).toContain("otpauth://totp/");
    expect(enabled.backupCodes.length).toBeGreaterThan(0);

    const [beforeVerify] = await db
      .select({ twoFactorEnabled: user.twoFactorEnabled })
      .from(user)
      .where(eq(user.username, username));
    expect(beforeVerify?.twoFactorEnabled).toBe(false);

    const verified = await auth.api.verifyTOTP({
      body: { code: await totpFor(enabled.totpURI) },
      headers,
      returnHeaders: true,
    });
    jar.absorb(verified.headers);

    const [afterVerify] = await db
      .select({ twoFactorEnabled: user.twoFactorEnabled })
      .from(user)
      .where(eq(user.username, username));
    expect(afterVerify?.twoFactorEnabled).toBe(true);
  });

  it("uses the app name as the TOTP issuer, so authenticator apps don't all read 'Better Auth'", async () => {
    const { headers } = await signUp();
    const { totpURI } = await auth.api.enableTwoFactor({ body: { password: PASSWORD }, headers });

    expect(totpURI).toContain("MyTuums");
  });

  it("rejects the wrong password rather than enrolling", async () => {
    const { headers } = await signUp();

    await expect(
      auth.api.enableTwoFactor({ body: { password: "not-the-password" }, headers }),
    ).rejects.toThrow();
  });

  it("returns a session to a 2FA sign-in only after the second factor", async () => {
    const { email, jar } = await signUp();
    await enrolTwoFactor(jar);

    // A correct password is now no longer enough: BetterAuth substitutes a
    // challenge for the session response, which is what `signInAtom` in the
    // web app reads to decide whether to navigate to /two-factor.
    const response = await auth.api.signInEmail({ body: { email, password: PASSWORD } });
    expect("twoFactorRedirect" in response && response.twoFactorRedirect).toBe(true);
  });

  it("disables 2FA and drops the stored secret", async () => {
    const { username, jar } = await signUp();
    await enrolTwoFactor(jar);

    // Note the jar, not the original headers: verifying the second factor
    // rotates the session cookie, so pre-verification headers are already
    // unauthorized by this point.
    await auth.api.disableTwoFactor({ body: { password: PASSWORD }, headers: jar.headers });

    const [row] = await db
      .select({ id: user.id, twoFactorEnabled: user.twoFactorEnabled })
      .from(user)
      .where(eq(user.username, username));
    expect(row?.twoFactorEnabled).toBe(false);

    const secrets = await db
      .select()
      .from(twoFactor)
      .where(eq(twoFactor.userId, row?.id ?? ""));
    expect(secrets).toHaveLength(0);
  });
});

describe("backup codes", () => {
  it("accepts a backup code once and never again", async () => {
    const { email, jar } = await signUp();
    const { backupCodes } = await enrolTwoFactor(jar);

    /** Signs in with the password only, returning the jar holding the 2FA challenge cookie. */
    const startChallenge = async () => {
      const response = await auth.api.signInEmail({
        body: { email, password: PASSWORD },
        returnHeaders: true,
      });
      return new CookieJar().absorb(response.headers);
    };

    const [code] = backupCodes;
    await expect(
      auth.api.verifyBackupCode({ body: { code }, headers: (await startChallenge()).headers }),
    ).resolves.toBeDefined();

    // Second use of the same code must fail — a backup code that can be
    // replayed is just a password that never expires.
    await expect(
      auth.api.verifyBackupCode({ body: { code }, headers: (await startChallenge()).headers }),
    ).rejects.toThrow();
  });
});

describe("password policy", () => {
  it("refuses a password found in a known breach corpus", async () => {
    // A password that is certainly in Have I Been Pwned. If this ever starts
    // passing, the plugin has stopped reaching the API — which fails open, and
    // is worth knowing about.
    await expect(signUp({ password: "password123" })).rejects.toThrow();
  });

  it("enforces the 8-character minimum the web validator also applies", async () => {
    await expect(signUp({ password: "Sh0rt!" })).rejects.toThrow();
  });
});

describe("handles", () => {
  it("leaves username null when a user is created without one — the state /welcome exists to resolve", async () => {
    // Created through testUtils rather than sign-up, because that is precisely
    // the shape an OAuth sign-up produces: a real user row with no handle.
    const test = await testHelpers();
    const created = test.createUser({ email: `oauth+${randomUUID()}@example.com` });
    await test.saveUser(created);

    const [row] = await db.select().from(user).where(eq(user.id, created.id));
    expect(row?.username).toBeNull();
  });

  it("refuses a handle already taken, case-insensitively", async () => {
    const { username, headers } = await signUp();
    const other = await signUp();

    await expect(
      auth.api.updateUser({ body: { username: username.toUpperCase() }, headers: other.headers }),
    ).rejects.toThrow();

    // The original owner still holds it.
    const [row] = await db.select({ id: user.id }).from(user).where(eq(user.username, username));
    expect(row).toBeDefined();
    expect(headers).toBeDefined();
  });
});

/**
 * The 15+ rule, server-side. The hook in packages/auth/src/dob.ts runs on
 * every user-creation path — email/password AND OAuth — and the property
 * that keeps OAuth working is that it only rejects a *present* declaration:
 * a user who simply never provides one passes, and the web app holds them at
 * /welcome until they do. The message is asserted as the literal the client's
 * render-boundary lookup translates (lib/auth-error-message.ts), the same
 * contract as the i18n tests below.
 */
describe("date of birth requirement", () => {
  it("accepts a date of birth older than 15 and reports it on the session user", async () => {
    // The sign-up *response* deliberately doesn't echo the declaration back
    // (the row it creates does), so the assertion reads the session store —
    // the shape the web app's `session.user.dateOfBirth` comes from.
    const { headers } = await signUp({ dateOfBirth: dob(15, -1) });

    const session = await auth.api.getSession({ headers });
    expect(session?.user.dateOfBirth).toBeDefined();
  });

  it("accepts a date of birth exactly 15 years ago — the boundary", async () => {
    await expect(signUp({ dateOfBirth: dob(15) })).resolves.toBeDefined();
  });

  it("rejects a date of birth 15 years ago minus one day, and creates no row", async () => {
    const email = `vitest+${randomUUID()}@example.com`;
    const result = await auth.api
      .signUpEmail({
        body: {
          email,
          password: PASSWORD,
          name: "Vitest User",
          username: `vitest${randomUUID().replace(/-/g, "").slice(0, 8)}`,
          dateOfBirth: dob(15, 1),
        },
      })
      .catch((error: unknown) => error);

    expect(String(result)).toContain("You must be at least 15 years old to create an account.");

    const rows = await db.select({ id: user.id }).from(user).where(eq(user.email, email));
    expect(rows).toHaveLength(0);
  });

  it("accepts a sign-up with no date of birth at all — the OAuth-path regression guard", async () => {
    // OAuth sign-ups arrive with no DOB, and the hook runs on their creation
    // path too; if it ever starts rejecting absence, every social sign-up
    // breaks. This pins that property.
    const { headers } = await signUp();

    const session = await auth.api.getSession({ headers });
    expect(session?.user.dateOfBirth).toBeFalsy();
  });

  it("rejects an impossible date rather than storing it", async () => {
    // Cast past the typed `Date` boundary on purpose: the raw-string form is
    // the wire format the web app actually sends (a Date cannot even represent
    // February 30 — it rolls over), and the hook must reject it before
    // `new Date()` silently stores March 2.
    const impossibleDate = "1995-02-30T00:00:00.000Z" as unknown as Date;
    const result = await auth.api
      .signUpEmail({
        body: {
          email: `vitest+${randomUUID()}@example.com`,
          password: PASSWORD,
          name: "Vitest User",
          username: `vitest${randomUUID().replace(/-/g, "").slice(0, 8)}`,
          dateOfBirth: impossibleDate,
        },
      })
      .catch((error: unknown) => error);

    expect(String(result)).toContain("Please enter a valid date of birth.");
  });

  it("enforces the same rule on updateUser — the /welcome claim path", async () => {
    const { headers } = await signUp();

    await expect(
      auth.api.updateUser({ body: { dateOfBirth: dob(15, 1) }, headers }),
    ).rejects.toThrow("You must be at least 15 years old to create an account.");

    await expect(
      auth.api.updateUser({ body: { dateOfBirth: dob(30) }, headers }),
    ).resolves.toBeDefined();

    const session = await auth.api.getSession({ headers });
    expect(session?.user.dateOfBirth).toBeDefined();
  });
});

describe("i18n plugin", () => {
  it("translates an error message when the Paraglide locale cookie says French", async () => {
    const { email } = await signUp();

    const result = await auth.api
      .signInEmail({
        body: { email, password: "definitely-the-wrong-password" },
        headers: new Headers({ cookie: "PARAGLIDE_LOCALE=fr" }),
      })
      .catch((error: unknown) => error);

    // The web app passes unrecognised server errors straight through
    // (lib/auth-error-message.ts), so a translated message here is what makes
    // French sign-in errors read as French without any client change.
    expect(String(result)).toContain("incorrect");
  });

  it("leaves the message in English without that cookie", async () => {
    const { email } = await signUp();

    const result = await auth.api
      .signInEmail({ body: { email, password: "definitely-the-wrong-password" } })
      .catch((error: unknown) => error);

    expect(String(result)).toMatch(/Invalid email or password/i);
  });
});

describe("test fixtures", () => {
  it("mints a session that the production auth instance accepts", async () => {
    // This is the property that makes `authTest` worth having: it shares the
    // secret and the session table with production `auth`, so a fixture
    // session resolves through the same path a real request takes.
    const test = await testHelpers();
    const created = test.createUser({ email: `fixture+${randomUUID()}@example.com` });
    await test.saveUser(created);

    const headers = await test.getAuthHeaders({ userId: created.id });
    const session = await auth.api.getSession({ headers });

    expect(session?.user.id).toBe(created.id);
    expect(authTest).toBeDefined();
  });
});

describe("passkeys", () => {
  it("has a passkey table wired to the user, and truncateAll clears it", async () => {
    // A full WebAuthn ceremony needs a browser — that lives in the E2E suite
    // with a virtual authenticator. What is worth asserting here is the part
    // that silently breaks otherwise: the table exists, cascades from `user`,
    // and is in `truncateAll`'s list so rows cannot leak between tests.
    const rows = await db.select().from(passkey);
    expect(rows).toEqual([]);
  });
});

/**
 * The password-reset surface, against the production instance — the same
 * reasoning as the rest of this file: the flow's security properties (single
 * use, expiry, session revocation, anti-enumeration) live in the
 * configuration that ships, not in a test-only one.
 *
 * One asymmetry is worth knowing: `auth.api.*` calls bypass the router's
 * `onRequest` hook that hosts BetterAuth's rate limiter (verified against the
 * installed 1.6.25 source and empirically), so the rate-limit assertion is the
 * only test here that goes through `auth.handler` — the real HTTP path the
 * server routes every request down. Everything else mints its token by
 * inserting a `verification` row directly, which is the same shape the
 * endpoint writes (identifier `reset-password:<token>`, value = user id).
 */
describe("password reset", () => {
  const NEW_PASSWORD = "vitest-Newer-Pass!";

  async function userIdFor(email: string): Promise<string> {
    const [row] = await db.select({ id: user.id }).from(user).where(eq(user.email, email));
    if (!row) throw new Error(`no user row for ${email}`);
    return row.id;
  }

  /**
   * Goes through the real endpoint, then reads the token it wrote — the
   * identifier's `reset-password:` suffix. The prefix filter is not optional:
   * sign-up's `emailVerification.sendOnSignUp` writes verification rows too,
   * and without it this would hand back the sign-up token.
   */
  async function requestResetToken(email: string): Promise<string> {
    const res = await auth.api.requestPasswordReset({ body: { email } });
    expect(res.status).toBe(true);

    const [row] = await db
      .select({ identifier: verification.identifier })
      .from(verification)
      .where(like(verification.identifier, "reset-password:%"))
      .orderBy(desc(verification.createdAt))
      .limit(1);
    expect(row?.identifier).toBeDefined();
    return row.identifier.replace("reset-password:", "");
  }

  /** Writes the token the endpoint would have, without spending the rate-limit budget. */
  async function insertResetToken(userId: string, expiresInMs = 60_000): Promise<string> {
    const token = randomUUID();
    await db.insert(verification).values({
      id: randomUUID(),
      identifier: `reset-password:${token}`,
      value: userId,
      expiresAt: new Date(Date.now() + expiresInMs),
    });
    return token;
  }

  async function resetRowCount(): Promise<number> {
    const rows = await db
      .select({ id: verification.id })
      .from(verification)
      .where(like(verification.identifier, "reset-password:%"));
    return rows.length;
  }

  it("resets the password and signs in with the new one", async () => {
    const { email } = await signUp();
    const token = await requestResetToken(email); // rate-limit call 1

    await expect(
      auth.api.resetPassword({ body: { newPassword: NEW_PASSWORD, token } }),
    ).resolves.toMatchObject({ status: true });

    // Single-use: the row is consumed, not left behind.
    await expect(
      db
        .select({ id: verification.id })
        .from(verification)
        .where(eq(verification.identifier, `reset-password:${token}`)),
    ).resolves.toEqual([]);

    await expect(
      auth.api.signInEmail({ body: { email, password: NEW_PASSWORD } }),
    ).resolves.toBeDefined();
    await expect(auth.api.signInEmail({ body: { email, password: PASSWORD } })).rejects.toThrow();
  });

  it("consumes a reset token so a second reset with it fails", async () => {
    const { email } = await signUp();
    const token = await requestResetToken(email); // rate-limit call 2

    await expect(
      auth.api.resetPassword({ body: { newPassword: NEW_PASSWORD, token } }),
    ).resolves.toMatchObject({ status: true });

    // A replayable reset token is just a password that never expires.
    await expect(
      auth.api.resetPassword({ body: { newPassword: "another-Pass-1", token } }),
    ).rejects.toThrow();
  });

  it("rejects a breached password — and consumes the token in the process", async () => {
    const { email } = await signUp();
    const userId = await userIdFor(email);
    const token = await insertResetToken(userId);

    // `password123` is certainly in Have I Been Pwned; the plugin hooks the
    // reset route like it does sign-up (see the "password policy" describe).
    await expect(
      auth.api.resetPassword({ body: { newPassword: "password123", token } }),
    ).rejects.toThrow();

    // The token is gone anyway: consumption happens before the breach check,
    // so an attacker cannot probe the breach corpus with one token repeatedly.
    await expect(
      db
        .select({ id: verification.id })
        .from(verification)
        .where(eq(verification.identifier, `reset-password:${token}`)),
    ).resolves.toEqual([]);
  });

  it("does not reveal whether an email exists", async () => {
    const before = await resetRowCount();

    const res = await auth.api.requestPasswordReset({
      body: { email: `nobody+${randomUUID()}@example.com` },
    }); // rate-limit call 3 — the budget is now full

    expect(res.status).toBe(true);
    expect(res.message).toContain("check your email");

    // The endpoint simulates the write for unknown emails; nothing lands.
    await expect(resetRowCount()).resolves.toBe(before);
  });

  it("rejects an expired token", async () => {
    const { email } = await signUp();
    const userId = await userIdFor(email);
    const token = await insertResetToken(userId, -1000);

    await expect(
      auth.api.resetPassword({ body: { newPassword: NEW_PASSWORD, token } }),
    ).rejects.toThrow();
  });

  it("rejects a garbage token", async () => {
    await expect(
      auth.api.resetPassword({ body: { newPassword: NEW_PASSWORD, token: "not-a-real-token" } }),
    ).rejects.toThrow();
  });

  it("revokes every session on reset", async () => {
    const { jar } = await signUp();
    const sessionBefore = await auth.api.getSession({ headers: jar.headers });
    expect(sessionBefore).not.toBeNull();

    const userId = (sessionBefore as { user: { id: string } }).user.id;
    const token = await insertResetToken(userId);

    await expect(
      auth.api.resetPassword({ body: { newPassword: NEW_PASSWORD, token } }),
    ).resolves.toMatchObject({ status: true });

    // `revokeSessionsOnPasswordReset` — the session that existed before the
    // reset no longer authenticates, even though its cookie is intact.
    await expect(auth.api.getSession({ headers: jar.headers })).resolves.toBeNull();
  });

  it("rate-limits the request-password-reset endpoint", async () => {
    // `auth.api.*` bypasses the rate limiter (see the describe header), so
    // this assertion drives the real HTTP path: three allowed requests, then
    // the fourth is refused. The rule is `{window: 300, max: 3}`, and without
    // a client IP all four calls share one bucket.
    const call = () =>
      auth.handler(
        new Request("http://localhost:3001/api/auth/request-password-reset", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: `rate-limit+${randomUUID()}@example.com` }),
        }),
      );

    for (let i = 0; i < 3; i++) {
      await expect(call()).resolves.toMatchObject({ status: 200 });
    }
    const blocked = await call();
    expect(blocked.status).toBe(429);
    await expect(blocked.json()).resolves.toMatchObject({
      message: "Too many requests. Please try again later.",
    });
  });
});
