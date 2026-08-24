import type { APIRequestContext } from "@playwright/test";
import { createUser } from "./db";
import { uniqueUser, type FixtureUser } from "./users";

/**
 * Signs up a throwaway account, grandfathers its email verified, and signs in —
 * leaving `request` carrying the session cookie the `api`-project specs make
 * authenticated `/rpc` and page requests with.
 *
 * The `api` project's specs used to rely on sign-up itself setting the session
 * cookie. With `requireEmailVerification` (packages/auth), sign-up creates the
 * account but issues NO session (issue #172), so a follow-up sign-in is what
 * mints the cookie. `createUser` already does the sign-up + grandfather (see
 * support/db.ts); this adds the sign-in through the same `request` context the
 * spec below will make its own calls with, so the cookie lands on that context's
 * jar rather than a one-off `fetch`'s.
 *
 * The `api` project's baseURL is the server origin (`E2E.serverUrl`), so the
 * cookie this sets is scoped to that origin — exactly the one the `/rpc` and
 * page requests hit. Returns the full fixture (incl. password) for specs that
 * need to address the account by handle or re-authenticate.
 */
export async function signUpVerifiedSession(
  request: APIRequestContext,
  prefix: string,
): Promise<FixtureUser> {
  const account = uniqueUser(prefix);
  await createUser(account);

  const signIn = await request.post("/api/auth/sign-in/email", {
    data: { email: account.email, password: account.password },
  });
  if (!signIn.ok()) {
    throw new Error(
      `signUpVerifiedSession("${prefix}") sign-in failed: ${String(signIn.status())} ${await signIn.text()}`,
    );
  }

  return account;
}
