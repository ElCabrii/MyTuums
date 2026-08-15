/**
 * The Better Auth half of the 15+ age rule: the `databaseHooks` adapter, and
 * nothing else.
 *
 * The rule itself — how a date of birth is parsed, how an age is compared, and
 * what a rejection says — lives in `./rules.js`, which the browser reads too
 * (`@my-tuums/auth/rules`). What is left here is the part only a server can
 * do: deciding that a *present* declaration failing the rule is an
 * `APIError`, and that an absent one is not an error at all.
 *
 * Wired in via `databaseHooks` in `./index.ts`, and deliberately NOT in
 * `./testing.ts` — fixtures are allowed to mint any row, including the
 * under-15 ones a test needs to hold.
 */
import { APIError } from "better-auth/api";
import {
  DOB_INVALID_MESSAGE,
  DOB_UNDER_AGE_MESSAGE,
  isAtLeastYearsOld,
  parseDateOfBirthParts,
} from "./rules.js";

type DateOfBirthInput = string | number | Date | object | null | undefined;

export interface DateOfBirthWrite {
  dateOfBirth?: DateOfBirthInput;
}

/**
 * The rule Better Auth runs before a user row is created or updated.
 *
 * Returns early when no date of birth is present — OAuth sign-ups arrive with
 * none, and this hook runs on every creation path, so throwing on absence
 * would break every social sign-up (see the `required: false` comment in
 * `./index.ts`). It rejects only a present declaration that is malformed or
 * under the threshold; a user who simply never provides one is the
 * `/welcome` gate's business on the client, not this hook's.
 *
 * Not `async` on purpose: the rule is synchronous, so the function returns
 * `Promise.resolve()` explicitly instead — Better Auth's hook type demands a
 * promise, and the linter's `require-await` forbids an `async` function with
 * nothing to await. The named write contract keeps the one field this module
 * owns explicit; the index module composes it with the profile contract.
 */
export function validateDateOfBirthHook(user: DateOfBirthWrite): Promise<void> {
  const raw = user.dateOfBirth;
  if (raw === undefined || raw === null || raw === "") return Promise.resolve();
  const parts = parseDateOfBirthParts(raw);
  if (!parts) {
    throw new APIError("BAD_REQUEST", { message: DOB_INVALID_MESSAGE });
  }
  if (!isAtLeastYearsOld(parts)) {
    throw new APIError("BAD_REQUEST", { message: DOB_UNDER_AGE_MESSAGE });
  }
  return Promise.resolve();
}
