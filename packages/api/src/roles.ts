/**
 * The role hierarchy the moderation system runs on (issue #38) — the source
 * of truth for every server-side role check in the app.
 *
 * Roles come from better-auth's admin plugin (`admin({ defaultRole: "user" })`
 * in packages/auth/src/index.ts), which stamps every account `user` and
 * carries the column on `session.user.role`. The plugin itself only ever
 * checks *membership* in a set (`adminRoles`) — it cannot express an ordering,
 * which is why its own endpoints are 404'd (apps/server/src/request-handler.ts)
 * and every gate here goes through the ordering below instead.
 *
 * The web app mirrors this ordering in apps/web/src/atoms/session.ts for what
 * the UI shows; the procedures are the real enforcement.
 */

/** The roles, weakest to strongest — the index *is* the rank. */
export const USER_ROLES = ["user", "moderator", "staff", "admin"] as const;

/** One of the four roles. */
export type UserRole = (typeof USER_ROLES)[number];

/**
 * The rank of a role, 0 (user) to 3 (admin). Unknown roles rank as -1: a
 * check that cannot see a role it knows nothing about must not pass.
 */
export function roleRank(role: string): number {
  return USER_ROLES.findIndex((candidate) => candidate === role);
}

/** True when `role` is at least `min` — `roleAtLeast(role, "staff")` gates staff+; `roleAtLeast(role, "user")` gates everyone. */
export function roleAtLeast(role: string, min: UserRole): boolean {
  return roleRank(role) >= roleRank(min);
}

/**
 * Whether `actorRole` may act on `targetRole` — the rank guard on
 * suspend/ban/setRole.
 *
 * Strictly greater, not merely "not equal": same rank cannot manage same
 * rank, and since an actor always holds their own rank, that also covers
 * acting on yourself. A moderator cannot suspend a moderator; an admin can
 * demote a staff member but not another admin.
 */
export function canManageRole(actorRole: string, targetRole: string): boolean {
  return roleRank(actorRole) > roleRank(targetRole);
}
