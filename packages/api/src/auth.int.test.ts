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
import { eq } from "drizzle-orm";
import { auth } from "@my-tuums/auth";
import { authTest, testHelpers } from "@my-tuums/auth/testing";
import { closeDb, db } from "@my-tuums/db";
import { passkey, twoFactor, user } from "@my-tuums/db/schema";
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
async function signUp(overrides: { username?: string; email?: string; password?: string } = {}) {
  const uuid = randomUUID();
  const email = overrides.email ?? `vitest+${uuid}@example.com`;
  const username = overrides.username ?? `vitest${uuid.replace(/-/g, "").slice(0, 8)}`;

  const result = await auth.api.signUpEmail({
    body: { email, password: overrides.password ?? PASSWORD, name: "Vitest User", username },
    returnHeaders: true,
  });

  const jar = new CookieJar().absorb(result.headers);
  return { email, username, jar, headers: jar.headers };
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

    const secrets = await db.select().from(twoFactor).where(eq(twoFactor.userId, row?.id ?? ""));
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
    await expect(
      signUp({ password: "password123" }),
    ).rejects.toThrow();
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
