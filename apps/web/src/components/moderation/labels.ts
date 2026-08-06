import { m } from "@/paraglide/messages.js";

/**
 * Translates an audit-log action code into user-facing copy. The codes are the
 * contract (`moderation_action.action`'s check constraint in packages/db) —
 * the fallback keeps a new code rendering as itself rather than crashing, and
 * the switch must gain a case when a code is added server-side.
 */
export function actionLabel(action: string): string {
  switch (action) {
    case "post_removed":
      return m.moderation_action_post_removed();
    case "post_restored":
      return m.moderation_action_post_restored();
    case "user_suspended":
      return m.moderation_action_user_suspended();
    case "user_unsuspended":
      return m.moderation_action_user_unsuspended();
    case "user_banned":
      return m.moderation_action_user_banned();
    case "user_unbanned":
      return m.moderation_action_user_unbanned();
    case "role_changed":
      return m.moderation_action_role_changed();
    case "case_resolved":
      return m.moderation_action_case_resolved();
    case "appeal_resolved":
      return m.moderation_action_appeal_resolved();
    default:
      return action;
  }
}

/**
 * Translates a role name into user-facing copy. The roles are the contract
 * (`USER_ROLES` in packages/api/src/roles.ts) — the fallback keeps an unknown
 * role rendering as itself.
 */
export function roleLabel(role: string): string {
  switch (role) {
    case "user":
      return m.moderation_role_user();
    case "moderator":
      return m.moderation_role_moderator();
    case "staff":
      return m.moderation_role_staff();
    case "admin":
      return m.moderation_role_admin();
    default:
      return role;
  }
}

/**
 * Translates a report-reason code into user-facing copy. The codes are the
 * contract (checked into `report`'s check constraint in packages/db and
 * accepted verbatim by `moderation.report`) — the fallback keeps an unknown
 * code rendering as itself.
 */
export function reasonLabel(reason: string): string {
  switch (reason) {
    case "spam":
      return m.moderation_reason_spam();
    case "harassment":
      return m.moderation_reason_harassment();
    case "hate_speech":
      return m.moderation_reason_hate_speech();
    case "misinformation":
      return m.moderation_reason_misinformation();
    case "self_harm":
      return m.moderation_reason_self_harm();
    case "illegal_content":
      return m.moderation_reason_illegal_content();
    case "nsfw":
      return m.moderation_reason_nsfw();
    case "impersonation":
      return m.moderation_reason_impersonation();
    case "underage":
      return m.moderation_reason_underage();
    default:
      return reason;
  }
}

/**
 * The numeric rank of a role, for client-side gating of the team view.
 *
 * Duplicated from `packages/api/src/roles.ts` on purpose: `roleRank` is not
 * web-exported (the package's exports map exposes only `.`, `./constants` and
 * `./dimensions`), and the team view needs "can I manage this member?" before
 * rendering the Change role button. The server is the real enforcement — this
 * only decides which buttons to draw — but the two must stay in agreement:
 * a rank raised or lowered server-side needs the same edit here.
 */
export function roleRank(role: string): number {
  switch (role) {
    case "admin":
      return 3;
    case "staff":
      return 2;
    case "moderator":
      return 1;
    default:
      return 0;
  }
}
