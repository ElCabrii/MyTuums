/**
 * The auth-hardening surface, against real BetterAuth and real Postgres.
 *
 * These exercise the *production* `auth` instance from `@my-tuums/auth`, not
 * the `authTest` one — the whole point is to assert the configuration that
 * ships (its plugins, its password rules, its French error messages), so a
 * test-only instance with a smaller plugin list would be asserting nothing.
 * `authTest` appears here only where a test needs a fixture minted cheaply.
 */
import { createHmac, randomUUID } from "node:crypto";
import { base32 } from "@better-auth/utils/base32";
import { createOTP } from "@better-auth/utils/otp";
import { desc, eq, like } from "drizzle-orm";
import { auth, PROVIDER_IMAGE_MAX_URL_LENGTH } from "@my-tuums/auth";
import {
  BIO_MAX_LENGTH,
  LEGAL_ACCEPTANCE_REQUIRED_MESSAGE,
  LEGAL_VERSION,
  USERNAME_CANONICAL_WRITE_MESSAGE,
} from "@my-tuums/auth/rules";
import { authTest, testHelpers } from "@my-tuums/auth/testing";
import { closeDb, db } from "@my-tuums/db";
import { twoFactor, user, verification } from "@my-tuums/db/schema";
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

/**
 * Builds the sign-up body from the overrides, shared by every helper below so
 * the wire format (and the `as never` bridge for the typed client boundary)
 * lives in one place.
 */
function signUpBody(overrides: {
  email?: string;
  password?: string;
  username?: string;
  dateOfBirth?: Date;
  legalAcceptedAt?: Date | string | null;
  legalVersion?: string | null;
}) {
  const uuid = randomUUID();
  const email = overrides.email ?? `vitest+${uuid}@example.com`;
  const username = overrides.username ?? `vitest${uuid.replace(/-/g, "").slice(0, 8)}`;
  const body: NonNullable<Parameters<typeof auth.api.signUpEmail>[0]>["body"] = {
    email,
    password: overrides.password ?? PASSWORD,
    name: "Vitest User",
    username,
    legalAcceptedAt: new Date(),
    legalVersion: LEGAL_VERSION,
  };
  // Omitted unless a test says otherwise — the wire format the web app sends
  // (`dateOfBirthToIso` in apps/web/src/lib/auth-validation.ts).
  if (overrides.dateOfBirth) body.dateOfBirth = overrides.dateOfBirth;
  if (overrides.legalAcceptedAt !== undefined) {
    // SAFETY: the test deliberately crosses the typed client boundary to send
    // the wire values the hook parses; the production client sends a string.
    body.legalAcceptedAt = overrides.legalAcceptedAt as never;
  }
  if (overrides.legalVersion !== undefined) {
    body.legalVersion = overrides.legalVersion;
  }
  return { email, username, body };
}

/**
 * Signs up through the real instance and returns a jar carrying a USABLE
 * session — the shape every test that calls `enableTwoFactor`, `updateUser`
 * or `getSession` needs.
 *
 * With `requireEmailVerification: true`, `signUpEmail` creates the account and
 * sends the verification email but issues NO session, so this grandfatheres the
 * fixture the same way `createTestUser` does (mirrors the 0014 migration): flip
 * `email_verified` directly, then sign in through the real instance. The
 * sign-in is unrate-limited because direct `auth.api.*` calls bypass the
 * router's `onRequest` rate limiter (see the password-reset block below).
 */
async function signUp(overrides: Parameters<typeof signUpBody>[0] = {}) {
  const { email, username, body } = signUpBody(overrides);

  const result = await auth.api.signUpEmail({ body, returnHeaders: true });
  // The unverified sign-up carries no session cookie — verified in the
  // "email verification" suite below — so mark the account verified and sign
  // in to mint the session the jar is for.
  await markEmailVerified(email);
  const signedIn = await auth.api.signInEmail({
    body: { email, password: overrides.password ?? PASSWORD },
    returnHeaders: true,
  });
  const jar = new CookieJar().absorb(result.headers).absorb(signedIn.headers);
  return { email, username, jar, headers: jar.headers };
}

/**
 * Signs up through the real instance and leaves the account UNVERIFIED — no
 * session, no sign-in. For the tests that assert the pre-verification state
 * (sign-up carries no session, unverified sign-in is rejected and re-sends)
 * and the one that needs sign-up alone with no sign-in after it
 * (`lastLoginMethod`).
 */
async function signUpUnverified(overrides: Parameters<typeof signUpBody>[0] = {}) {
  const { email, username, body } = signUpBody(overrides);
  const result = await auth.api.signUpEmail({ body, returnHeaders: true });
  return { email, username, headers: result.headers };
}

/** Flips `email_verified` directly — the fixture half of the 0014 grandfather. */
async function markEmailVerified(email: string) {
  await db.update(user).set({ emailVerified: true }).where(eq(user.email, email));
}

/**
 * Mints a verification JWT exactly the way Better Auth's
 * `createEmailVerificationToken` does: an HS256 token signed with the
 * production instance's own secret, payload `{ email }`, expiring in
 * `expiresInSec`. The token is stateless (the verify-email endpoint verifies it
 * purely from the signature, no `verification` row), so a test can mint one for
 * any address and drive `/verify-email` directly — the same shape a real
 * verification link carries. A negative `expiresInSec` produces an already-
 * expired token for the failure-path tests; `secretOverride` signs with a
 * different key to produce an INVALID_TOKEN.
 *
 * Built with `node:crypto` rather than `jose` (which better-auth uses
 * internally) so this package takes no new dependency for a test-only helper —
 * HS256 is just HMAC-SHA256 over `base64url(header).base64url(payload)`, which
 * is what `jose`'s `SignJWT` produces and `jwtVerify` checks.
 */
function signVerificationJwt(email: string, expiresInSec: number, secret: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({ email: email.toLowerCase(), iat: now, exp: now + expiresInSec }),
  ).toString("base64url");
  const data = `${header}.${payload}`;
  const signature = createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${signature}`;
}

async function verificationToken(email: string, expiresInSec = 3600): Promise<string> {
  // SAFETY: `auth.$context` is the resolved context the endpoints close over,
  // and better-auth's create-context.mjs always sets `.secret` to a string
  // (from BETTER_AUTH_SECRET) before the context resolves — it is the same
  // value `createEmailVerificationToken` signs with, so a token minted here
  // validates against the real flow. The narrowing reads that one field; a
  // shape change upstream surfaces as the signature check failing in the
  // tests below, not as a silent pass.
  const context = (await auth.$context) as { secret: string };
  return signVerificationJwt(email, expiresInSec, context.secret);
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

/**
 * The email-verification gate (issue #172), against the production instance.
 *
 * With `requireEmailVerification: true`, a password sign-up creates the account
 * and sends the verification email but issues NO session, and a password
 * sign-in on an unverified account is rejected (re-sending the verification
 * email via `sendOnSignIn`). The security property is that an unverified
 * password account never holds a session; these pin both halves of it plus the
 * recovery path (verify creates a session) and the failure modes (expired,
 * invalid, already-verified) so a bad link can't be an oracle or a backdoor.
 *
 * The sends themselves (`sendOnSignUp`, the `sendOnSignIn` resend) are not
 * asserted here: Better Auth's `sendEmail` has no injectable seam (the
 * production instance captures it in its config closure), and the repo forbids
 * module mocking (oxlint `anti-slop/no-module-mocking`). The `sendOnSignUp` /
 * `sendOnSignIn` config is the contract; the observable gate — no session until
 * verified — is what these tests hold.
 */
describe("email verification", () => {
  it("sign-up creates the account but issues no session cookie", async () => {
    const { email, headers } = await signUpUnverified();

    // The account exists…
    const [row] = await db.select({ id: user.id }).from(user).where(eq(user.email, email));
    expect(row).toBeDefined();
    // …but no session cookie was set. The whole gate is "no session until
    // verified", and a present session cookie here would mean a backdoor.
    expect(headers.getSetCookie().some((c) => c.startsWith("better-auth.session_token="))).toBe(
      false,
    );
  });

  it("rejects a sign-in on an unverified account and leaves it unusable", async () => {
    const { email } = await signUpUnverified();

    // Correct password, unverified account: Better Auth verifies the password
    // first, THEN hits the `requireEmailVerification` check — so this is the
    // EMAIL_NOT_VERIFIED rejection, not a wrong-password one. `sendOnSignIn`
    // re-sends the verification email as part of this same rejection (the
    // recovery path); the resend is config, not asserted here (see the suite
    // docblock).
    await expect(auth.api.signInEmail({ body: { email, password: PASSWORD } })).rejects.toThrow(
      /EMAIL_NOT_VERIFIED|not verified/i,
    );

    // And no session was created — the account is still unusable.
    const [row] = await db
      .select({ emailVerified: user.emailVerified })
      .from(user)
      .where(eq(user.email, email));
    expect(row?.emailVerified).toBe(false);
  });

  it("creates a session when the verification link is followed", async () => {
    const { email } = await signUpUnverified();

    // No callbackURL: the endpoint returns JSON and sets the session cookie
    // (autoSignInAfterVerification) rather than redirecting, so the jar can
    // capture it. A real link carries callbackURL and redirects; the session
    // creation is the same either way.
    const token = await verificationToken(email);
    const result = await auth.api.verifyEmail({ query: { token }, returnHeaders: true });
    const jar = new CookieJar().absorb(result.headers);

    const session = await auth.api.getSession({ headers: jar.headers });
    expect(session?.user.id).toBeDefined();
    expect(session?.user.emailVerified).toBe(true);

    const [row] = await db
      .select({ emailVerified: user.emailVerified })
      .from(user)
      .where(eq(user.email, email));
    expect(row?.emailVerified).toBe(true);
  });

  it("rejects an expired token with TOKEN_EXPIRED", async () => {
    const { email } = await signUpUnverified();
    const token = await verificationToken(email, -10);

    // No callbackURL, so the endpoint throws the APIError straight (a real
    // link carries callbackURL and redirects to `?error=TOKEN_EXPIRED`); the
    // message is Better Auth's stable base text for the code.
    await expect(auth.api.verifyEmail({ query: { token } })).rejects.toThrow(/Token expired/i);
  });

  it("rejects an invalid token with INVALID_TOKEN", async () => {
    const { email } = await signUpUnverified();
    // A token signed with the wrong secret is invalid rather than expired —
    // the same class a tampered or truncated link falls into.
    const token = signVerificationJwt(email, 60, "definitely-not-the-real-secret");

    await expect(auth.api.verifyEmail({ query: { token } })).rejects.toThrow(/Invalid token/i);
  });

  it("treats a second verification of an already-verified account as a no-op, not a session", async () => {
    const { email } = await signUpUnverified();
    const token = await verificationToken(email);

    // First verify: creates the session and marks the account verified.
    await auth.api.verifyEmail({ query: { token }, returnHeaders: true });

    // Second verify with the same token: the account is already verified, so
    // the endpoint short-circuits to `{ status: true, user: null }` and sets NO
    // session cookie — a reused link can't mint a second session.
    const result = await auth.api.verifyEmail({ query: { token }, returnHeaders: true });
    expect(
      result.headers.getSetCookie().some((c) => c.startsWith("better-auth.session_token=")),
    ).toBe(false);
  });
});

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

describe("emailed one-time codes", () => {
  it("an emailed OTP completes the sign-in challenge", async () => {
    const { email, jar } = await signUp();
    await enrolTwoFactor(jar);

    const challenge = await auth.api.signInEmail({
      body: { email, password: PASSWORD },
      returnHeaders: true,
    });
    const challengeJar = new CookieJar().absorb(challenge.headers);

    // No mailbox in the test stack and the production `sendEmail` has no
    // injectable seam (see the email-verification note above), so the code is
    // read from the verification table — the row the plugin wrote while
    // handling the send, keyed on the signed challenge cookie's unsigned
    // payload, which is the challenge's only identity mid-challenge. The
    // cookie value is URL-encoded on the wire (`+`/`=`), and the payload
    // charset contains no `.`, so splitting on the first dot isolates it the
    // same way the server's `getSignedCookie` does.
    await auth.api.sendTwoFactorOTP({ headers: challengeJar.headers });

    const challengeCookie = challenge.headers
      .getSetCookie()
      .map((raw) => raw.split(";")[0] ?? "")
      .find((pair) => pair.startsWith("better-auth.two_factor="));
    if (!challengeCookie) throw new Error("no two-factor challenge cookie after sign-in");
    const challengeKey = decodeURIComponent(challengeCookie.slice(challengeCookie.indexOf("=") + 1))
      .split(".")[0]
      .trim();

    const [row] = await db
      .select({ value: verification.value })
      .from(verification)
      // `eq`, not `like`: the identifier is exactly `2fa-otp-<key>` with no
      // suffix, and the key's charset includes `_`, which LIKE treats as a
      // single-character wildcard.
      .where(eq(verification.identifier, `2fa-otp-${challengeKey}`))
      .orderBy(desc(verification.createdAt))
      .limit(1);
    if (!row) throw new Error("no OTP was stored for the challenge");
    const otp = row.value.split(":")[0];

    const verified = await auth.api.verifyTwoFactorOTP({
      body: { code: otp },
      headers: challengeJar.headers,
      returnHeaders: true,
    });
    const session = new CookieJar().absorb(verified.headers);

    const who = await auth.api.getSession({ headers: session.headers });
    expect(who?.user.email).toBe(email);
  });
});

describe("password policy", () => {
  it("enforces the 8-character minimum the web validator also applies", async () => {
    await expect(signUp({ password: "Sh0rt!" })).rejects.toThrow();
  });
});

describe("password change", () => {
  it("refuses a wrong current password", async () => {
    const { jar } = await signUp();

    // The current-password check is the only thing standing between somebody
    // with a hijacked session and ownership of the account.
    await expect(
      auth.api.changePassword({
        body: { currentPassword: "not-the-password", newPassword: "vitest-AnotherSecret2!" },
        headers: jar.headers,
      }),
    ).rejects.toThrow();
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

  it("stores and returns lowercase handles after sign-up and handle changes", async () => {
    const { email, headers } = await signUp({ username: "AlexMercer" });

    const [created] = await db
      .select({ username: user.username, displayUsername: user.displayUsername })
      .from(user)
      .where(eq(user.email, email));
    expect(created).toEqual({ username: "alexmercer", displayUsername: "alexmercer" });

    const firstSession = await auth.api.getSession({ headers });
    expect(firstSession?.user).toMatchObject({
      username: "alexmercer",
      displayUsername: "alexmercer",
    });

    await auth.api.updateUser({ body: { username: "NewHandle" }, headers });

    const [updated] = await db
      .select({ username: user.username, displayUsername: user.displayUsername })
      .from(user)
      .where(eq(user.email, email));
    expect(updated).toEqual({ username: "newhandle", displayUsername: "newhandle" });

    const updatedSession = await auth.api.getSession({ headers });
    expect(updatedSession?.user).toMatchObject({
      username: "newhandle",
      displayUsername: "newhandle",
    });
  });

  it("rejects display-only handle updates instead of splitting the two handle columns", async () => {
    const { email, headers } = await signUp({ username: "AlexMercer" });

    await expect(
      auth.api.updateUser({ body: { displayUsername: "AlternateHandle" }, headers }),
    ).rejects.toThrow(USERNAME_CANONICAL_WRITE_MESSAGE);

    const [unchanged] = await db
      .select({ username: user.username, displayUsername: user.displayUsername })
      .from(user)
      .where(eq(user.email, email));
    expect(unchanged).toEqual({ username: "alexmercer", displayUsername: "alexmercer" });
  });

  it("normalizes legacy writes at the database boundary during a rolling deploy", async () => {
    const { email } = await signUp({ username: "InitialHandle" });

    // Models the version that remains live while Railway's pre-deploy
    // migration runs: it canonicalises username but preserves typed casing in
    // displayUsername. The migration trigger must make that old write safe.
    await db
      .update(user)
      .set({ username: "legacyhandle", displayUsername: "LegacyHandle" })
      .where(eq(user.email, email));

    const [updated] = await db
      .select({ username: user.username, displayUsername: user.displayUsername })
      .from(user)
      .where(eq(user.email, email));
    expect(updated).toEqual({ username: "legacyhandle", displayUsername: "legacyhandle" });

    // Direct display-only writes cannot split the columns either.
    await db.update(user).set({ displayUsername: "AlternateHandle" }).where(eq(user.email, email));

    const [resynchronized] = await db
      .select({ username: user.username, displayUsername: user.displayUsername })
      .from(user)
      .where(eq(user.email, email));
    expect(resynchronized).toEqual({
      username: "legacyhandle",
      displayUsername: "legacyhandle",
    });
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
    await expect(
      auth.api.signUpEmail({
        body: {
          email,
          password: PASSWORD,
          name: "Vitest User",
          username: `vitest${randomUUID().replace(/-/g, "").slice(0, 8)}`,
          dateOfBirth: dob(15, 1),
          legalAcceptedAt: new Date(),
          legalVersion: LEGAL_VERSION,
        },
      }),
    ).rejects.toThrow("You must be at least 15 years old to create an account.");

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

/**
 * Legal acceptance, server-side. The hook in
 * packages/auth/src/legal.ts is deliberately narrower than the other user
 * hooks: it requires consent only on `/sign-up/email`, because that is the
 * one path that presents the checkbox. Existing accounts and OAuth/passkey
 * sign-ups remain `NULL`; issue #157 owns the remaining creation paths.
 */
describe("legal acceptance", () => {
  it("records the accepted timestamp and version on email/password sign-up", async () => {
    const { email } = await signUp();

    const [row] = await db.select().from(user).where(eq(user.email, email));
    expect(row?.legalAcceptedAt).toBeInstanceOf(Date);
    expect(row?.legalVersion).toBe(LEGAL_VERSION);
  });

  it("rejects email/password sign-up without consent and creates no row", async () => {
    const email = `vitest+${randomUUID()}@example.com`;
    await expect(
      auth.api.signUpEmail({
        body: {
          email,
          password: PASSWORD,
          name: "Vitest User",
          username: `vitest${randomUUID().replace(/-/g, "").slice(0, 8)}`,
        },
      }),
    ).rejects.toThrow(LEGAL_ACCEPTANCE_REQUIRED_MESSAGE);

    const rows = await db.select({ id: user.id }).from(user).where(eq(user.email, email));
    expect(rows).toHaveLength(0);
  });

  it("rejects a stale legal version rather than recording consent against it", async () => {
    const email = `vitest+${randomUUID()}@example.com`;
    await expect(
      auth.api.signUpEmail({
        body: {
          email,
          password: PASSWORD,
          name: "Vitest User",
          username: `vitest${randomUUID().replace(/-/g, "").slice(0, 8)}`,
          legalAcceptedAt: new Date(),
          legalVersion: "2020-01-01",
        },
      }),
    ).rejects.toThrow(LEGAL_ACCEPTANCE_REQUIRED_MESSAGE);

    const rows = await db.select({ id: user.id }).from(user).where(eq(user.email, email));
    expect(rows).toHaveLength(0);
  });

  /**
   * Sign-up must leave the writes it makes to its own row alone.
   * `lastLoginMethod({ storeInDatabase: true })` updates the row it just
   * created from inside the same `/sign-up/email` request, carrying no
   * consent fields — which is why the rule runs on `create.before` only and
   * not on `update.before` (packages/auth/src/index.ts's
   * `validateUserCreate`). Wiring it to both left `last_login_method` unset
   * and logged a Better Auth error on every sign-up.
   *
   * Note the limit of this assertion: `auth.api.signUpEmail` is a direct
   * call, and the inner update does not inherit the `/sign-up/email` path the
   * way it does over HTTP, so this does not fail under the old wiring. The
   * E2E stack is where that showed up. Kept because the column being
   * populated by sign-up alone is the behaviour worth pinning.
   */
  it("records lastLoginMethod on sign-up alone, with no sign-in after it", async () => {
    // `signUpUnverified` rather than `signUp`: with `requireEmailVerification`
    // sign-up issues no session, so this is genuinely sign-up alone — no
    // sign-in, no session-create hook — and the column must still land. (The
    // verified+signed-in `signUp` would let `session.create.after` write it
    // too, which is exactly the "sign-in after it" this test says it isn't.)
    const { email } = await signUpUnverified();

    const [row] = await db.select().from(user).where(eq(user.email, email));
    expect(row?.lastLoginMethod).toBe("email");
  });

  it("does not require consent on updateUser — existing accounts and partial edits pass", async () => {
    const { headers } = await signUp();

    await expect(
      auth.api.updateUser({ body: { name: "Renamed" }, headers }),
    ).resolves.toBeDefined();
  });
});

/**
 * The editable-profile rules, server-side — the other `databaseHooks` half
 * (packages/auth/src/profile.ts).
 *
 * What is asserted here is the *adapter*: that the hook is wired into the
 * production instance at all, that it turns a rule violation into a
 * `BAD_REQUEST` carrying the exact English literal
 * `apps/web/src/lib/auth-error-message.ts` is keyed on, and that it lets a
 * partial update through untouched. The rules themselves — where the bio bound
 * falls, which preference values exist — are `account-rules.test.ts`'s job, so
 * they are not re-litigated here.
 */
describe("profile field rules", () => {
  it("rejects a bio over the limit and accepts one exactly at it", async () => {
    const { headers } = await signUp();

    await expect(
      auth.api.updateUser({ body: { bio: "x".repeat(BIO_MAX_LENGTH + 1) }, headers }),
    ).rejects.toThrow("Your bio must be 160 characters or fewer.");

    // The bound is inclusive, and the rule measures what is about to be stored
    // rather than a trimmed copy of it.
    await expect(
      auth.api.updateUser({ body: { bio: "x".repeat(BIO_MAX_LENGTH) }, headers }),
    ).resolves.toBeDefined();
  });

  it("rejects an image or banner URL long enough to amplify every feed row, and accepts one exactly at the bound", async () => {
    const { headers } = await signUp();

    // A provider avatar is a couple of hundred characters; this is orders of
    // magnitude past that, still shaped like a real URL so only the length
    // bound (not the scheme or parse checks) can trip.
    const prefix = "https://cdn.example.test/avatar/";
    const suffix = ".png";
    const oversized = `${prefix}${"a".repeat(PROVIDER_IMAGE_MAX_URL_LENGTH - prefix.length - suffix.length + 1)}${suffix}`;
    expect(oversized.length).toBe(PROVIDER_IMAGE_MAX_URL_LENGTH + 1);
    // Asserted as the literal, because the web app's render-boundary lookup
    // (lib/auth-error-message.ts) is keyed on exactly this sentence — a drift
    // here must fail this test so the translation table is updated too.
    await expect(auth.api.updateUser({ body: { image: oversized }, headers })).rejects.toThrow(
      "Profile images are set by uploading a file.",
    );
    await expect(
      auth.api.updateUser({ body: { bannerImage: oversized }, headers }),
    ).rejects.toThrow("Profile images are set by uploading a file.");

    // The bound is inclusive, like the bio's — a URL exactly at it passes.
    const atBound = `${prefix}${"a".repeat(PROVIDER_IMAGE_MAX_URL_LENGTH - prefix.length - suffix.length)}${suffix}`;
    expect(atBound.length).toBe(PROVIDER_IMAGE_MAX_URL_LENGTH);
    await expect(auth.api.updateUser({ body: { image: atBound }, headers })).resolves.toBeDefined();
  });

  it("rejects a theme or locale outside the offered values", async () => {
    const { headers } = await signUp();

    await expect(
      auth.api.updateUser({ body: { themePreference: "sepia" }, headers }),
    ).rejects.toThrow("Please choose a valid theme.");

    await expect(
      auth.api.updateUser({ body: { localePreference: "de" }, headers }),
    ).rejects.toThrow("Please choose a valid language.");
  });

  it("lets an unrelated partial update through — absence is not a violation", async () => {
    // The hook sees *partial* updates: someone changing only their display
    // name arrives with bio and both preferences undefined. Treating that as a
    // violation would reject every unrelated write.
    const { headers } = await signUp();

    await expect(
      auth.api.updateUser({ body: { name: "Renamed" }, headers }),
    ).resolves.toBeDefined();

    const session = await auth.api.getSession({ headers });
    expect(session?.user.name).toBe("Renamed");
  });
});

describe("i18n plugin", () => {
  it("translates an error message when the Paraglide locale cookie says French", async () => {
    const { email } = await signUp();

    await expect(
      auth.api.signInEmail({
        body: { email, password: "definitely-the-wrong-password" },
        headers: new Headers({ cookie: "PARAGLIDE_LOCALE=fr" }),
      }),
    ).rejects.toThrow("incorrect");
  });

  it("leaves the message in English without that cookie", async () => {
    const { email } = await signUp();

    await expect(
      auth.api.signInEmail({ body: { email, password: "definitely-the-wrong-password" } }),
    ).rejects.toThrow(/Invalid email or password/i);
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
    if (!sessionBefore) throw new Error("expected a session before password reset");

    const userId = sessionBefore.user.id;
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
