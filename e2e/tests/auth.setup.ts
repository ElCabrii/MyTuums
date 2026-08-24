import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test as setup, type APIRequestContext } from "@playwright/test";
import { E2E } from "../playwright.config";
import { getUserId, markEmailVerified, setUserRole } from "../support/db";
import { ALICE, FIXTURE_USERS, legalConsentBody, type FixtureUser } from "../support/users";

// Lives under `tests/` rather than at the package root: playwright.config.ts
// sets `testDir: "./tests"`, and Playwright only ever discovers spec files by
// scanning that directory — a `testMatch` pattern (the "setup" project's is
// `/.*\.setup\.ts/`) only filters files that scan already found, it can't
// reach outside testDir.
//
// `storageState({ path })` doesn't create the directory for you.
mkdirSync(path.join(import.meta.dirname, "..", ".auth"), { recursive: true });

/**
 * Signs up (or, failing that, signs in) one fixture account and returns once
 * the request context is carrying its session cookie.
 *
 * Hits `E2E.webUrl`, not `E2E.serverUrl`: the cookie BetterAuth sets has to be
 * scoped to the origin the *browser* will use later, and `Set-Cookie` has no
 * explicit `Domain` attribute, so it defaults to whatever host actually
 * received the request as far as this `APIRequestContext`'s cookie jar is
 * concerned. Vite's dev proxy forwards the request to the server on the way
 * through, but that's transparent here — this context only ever sees 5273.
 *
 * Idempotent because `global-setup.ts`'s truncation is what actually
 * guarantees a clean slate every run; this fallback only matters for
 * re-running the `setup` project on its own (e.g. `--project setup`) without
 * a fresh truncation ahead of it.
 *
 * With `requireEmailVerification` (packages/auth), a successful sign-up
 * creates the account and sends the verification email but issues NO session —
 * so a sign-up that returns ok no longer leaves this context carrying a
 * session cookie. The fixture is grandfathered the same way the
 * `0014_grandfather_email_verified` migration grandfathered every real
 * account: flip `email_verified` directly, then sign in to mint the cookie.
 * The sign-in path also covers the re-run case where the account already
 * exists (sign-up then returns non-ok) and was verified by a previous run.
 */
async function ensureFixtureSession(request: APIRequestContext, user: FixtureUser): Promise<void> {
  const signUpResponse = await request.post(`${E2E.webUrl}/api/auth/sign-up/email`, {
    data: {
      email: user.email,
      password: user.password,
      name: user.name,
      username: user.username,
      // The ISO form the web form sends — without it, alice/bob would park at
      // /welcome on their first navigation and the whole suite would break.
      dateOfBirth: `${user.dateOfBirth}T00:00:00.000Z`,
      ...legalConsentBody(),
    },
  });

  // A fresh sign-up: the account exists but is unverified, so grandfather it
  // before the sign-in below — otherwise sign-in is rejected with
  // EMAIL_NOT_VERIFIED and no session cookie is set. A non-ok sign-up means
  // the account already exists (a re-run without truncation); it was verified
  // by a previous run, so there is nothing to flip here.
  if (signUpResponse.ok()) {
    // SAFETY: A successful Better Auth sign-up response owns this `user`
    // contract; the ok check above guards the consumption.
    const body = (await signUpResponse.json()) as { user?: { id?: string } };
    const userId = body?.user?.id;
    if (!userId) {
      throw new Error(
        `Sign-up for fixture "${user.username}" returned ok but no user.id — ` +
          `the Better Auth sign-up response shape has changed.`,
      );
    }
    await markEmailVerified(userId);
  }

  const signInResponse = await request.post(`${E2E.webUrl}/api/auth/sign-in/email`, {
    data: { email: user.email, password: user.password },
  });

  if (!signInResponse.ok()) {
    throw new Error(
      `Could not sign up or sign in fixture user "${user.username}": ` +
        `sign-up -> ${String(signUpResponse.status())} ${await signUpResponse.text()}; ` +
        `sign-in -> ${String(signInResponse.status())} ${await signInResponse.text()}`,
    );
  }
}

for (const user of FIXTURE_USERS) {
  setup(`authenticate as ${user.username}`, async ({ request }) => {
    await ensureFixtureSession(request, user);

    // Alice is the suite's moderator fixture (moderation.spec.ts walks the
    // queue as her). Promoted through the row — the admin plugin's endpoints
    // are blocked — and idempotent, so re-running `--project setup` on its
    // own (the sign-in fallback path above) can't wedge on the constraint.
    if (user.username === ALICE.username) {
      const aliceId = await getUserId(ALICE.username);
      await setUserRole(aliceId, "moderator");
    }

    // Sanity check before writing storage state that would otherwise fail
    // every downstream browser spec with a much less obvious error. Alice's
    // role is asserted too: the promotion above is the suite's moderator
    // fixture, and if it ever silently failed (a migration gap, a wrong
    // row), the failure would otherwise surface as confusing FORBIDDEN
    // errors in moderation.spec.ts instead of here at setup.
    const session = await request.get(`${E2E.webUrl}/api/auth/get-session`);
    expect(session.ok(), `get-session should succeed once signed in as ${user.username}`).toBe(
      true,
    );
    // SAFETY: This is Better Auth's get-session endpoint; the assertions below
    // verify the two optional user fields this setup step consumes.
    const body = (await session.json()) as { user?: { username?: string; role?: string } } | null;
    expect(body?.user?.username, `session user should be ${user.username}`).toBe(user.username);
    if (user.username === ALICE.username) {
      expect(body?.user?.role, "alice should be the suite's moderator fixture").toBe("moderator");
    }

    await request.storageState({ path: E2E.storageStateFor(user.username) });
  });
}
