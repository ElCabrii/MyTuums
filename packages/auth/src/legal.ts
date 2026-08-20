/**
 * The Better Auth half of the legal acceptance rule.
 *
 * Unlike the date-of-birth and profile hooks, this rule is not "reject a
 * present value that is invalid". Email/password sign-up is the one path that
 * presents the consent box, so the hook requires both fields on that path and
 * leaves every other user write alone. OAuth and passkey sign-up paths are
 * handled by the web app's global legal consent dialog after sign-in;
 * requiring legal consent on every create would break them.
 */
import { APIError } from "better-auth/api";
import { LEGAL_ACCEPTANCE_REQUIRED_MESSAGE, LEGAL_VERSION } from "./rules.js";

type BetterAuthFieldValue = string | number | boolean | Date | object | null | undefined;

export interface LegalAcceptanceWrite {
  legalAcceptedAt?: BetterAuthFieldValue;
  legalVersion?: BetterAuthFieldValue;
}

type LegalHookContext = { path?: string } | null;

function stringFieldValue<Value>(value: Value): string | null {
  return Object.prototype.toString.call(value) === "[object String]"
    ? String.prototype.valueOf.call(value)
    : null;
}

function isBlank<Value>(value: Value): boolean {
  return value === undefined || value === null || value === "";
}

function isDateValue<Value>(value: Value): boolean {
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  const stringValue = stringFieldValue(value);
  if (stringValue === null) return false;
  const parsed = new Date(stringValue);
  return !Number.isNaN(parsed.getTime());
}

/**
 * The rule Better Auth runs before a user row is created.
 *
 * It only enforces on `/sign-up/email`, the one creation path that can and
 * must carry consent. Existing accounts and partial updates pass untouched;
 * the columns are nullable so accounts created before this change remain
 * `NULL` rather than being retroactively marked as accepted.
 */
export function validateLegalAcceptanceHook(
  user: LegalAcceptanceWrite,
  context: LegalHookContext,
): Promise<void> {
  if (context?.path !== "/sign-up/email") return Promise.resolve();

  const acceptedAt = user.legalAcceptedAt;
  const version = user.legalVersion;
  if (isBlank(acceptedAt) || isBlank(version) || !isDateValue(acceptedAt)) {
    throw new APIError("BAD_REQUEST", { message: LEGAL_ACCEPTANCE_REQUIRED_MESSAGE });
  }
  if (stringFieldValue(version) !== LEGAL_VERSION) {
    throw new APIError("BAD_REQUEST", { message: LEGAL_ACCEPTANCE_REQUIRED_MESSAGE });
  }

  return Promise.resolve();
}
