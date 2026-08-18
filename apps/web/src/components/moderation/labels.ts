import { createElement, type ReactNode } from "react";
import {
  Activity,
  Ban,
  CheckCheck,
  Crown,
  Hourglass,
  type LucideIcon,
  Scale,
  Shield,
  ShieldCheck,
  Trash2,
  Undo2,
  User,
  UserCog,
} from "lucide-react";
import { m } from "@/paraglide/messages.js";
import { USER_ROLES, type UserRole } from "@my-tuums/api/roles";

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
 * role rendering as itself. `ROLE_LABELS` is `satisfies Record<UserRole, …>`,
 * so adding a role to `USER_ROLES` without a label here is a type error.
 */
const ROLE_LABELS = {
  user: () => m.moderation_role_user(),
  moderator: () => m.moderation_role_moderator(),
  staff: () => m.moderation_role_staff(),
  admin: () => m.moderation_role_admin(),
} satisfies Record<UserRole, () => string>;

export function roleLabel(role: string): string {
  // SAFETY: `USER_ROLES.includes` has just confirmed `role` is a member of the
  // tuple, so the cast narrows a checked string to the union it was tested
  // against; anything else falls through to the raw string.
  return USER_ROLES.includes(role as UserRole) ? ROLE_LABELS[role as UserRole]() : role;
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
 * How loudly a report reason should read in the queue and the case dialog.
 *
 * A moderator triaging a page of cases needs to see which ones cannot wait
 * before reading a single word, and the only severity signal the API carries
 * is the reason code itself (`report.reason`'s check constraint in
 * packages/db) — there is no priority column to render. So the split is made
 * here, from the same codes {@link reasonLabel} translates: the four reasons
 * that describe harm to a person or the law read `destructive`, the rest read
 * as a neutral chip. An unknown code stays neutral, like every other fallback
 * in this file — a new reason must be classified deliberately, not inherit
 * urgency by accident.
 */
export function reasonBadgeVariant(reason: string): "destructive" | "secondary" {
  switch (reason) {
    case "illegal_content":
    case "self_harm":
    case "hate_speech":
    case "underage":
      return "destructive";
    default:
      return "secondary";
  }
}

/**
 * How an audit-log action reads: `destructive` for the ones that took
 * something away, `secondary` for the ones that gave it back or merely closed
 * a case. Same contract and same fallback reasoning as {@link actionLabel} —
 * a new code renders neutral until it is classified here.
 */
export function actionBadgeVariant(action: string): "destructive" | "secondary" {
  switch (action) {
    case "post_removed":
    case "user_suspended":
    case "user_banned":
      return "destructive";
    default:
      return "secondary";
  }
}

/**
 * The glyph an audit-log action carries. Same contract and same fallback
 * reasoning as {@link actionLabel}: an unclassified code gets the generic
 * activity glyph rather than borrowing another action's meaning.
 *
 * Returns the rendered element rather than the component: a caller holding
 * `const Icon = actionIcon(...)` would be declaring a component inside its own
 * render, which is both what `react-hooks/static-components` rejects and what
 * would remount the glyph on every keystroke elsewhere in the row.
 */
export function actionIcon(action: string): ReactNode {
  return createElement(actionIconComponent(action));
}

function actionIconComponent(action: string): LucideIcon {
  switch (action) {
    case "post_removed":
      return Trash2;
    case "post_restored":
    case "user_unsuspended":
    case "user_unbanned":
      return Undo2;
    case "user_suspended":
      return Hourglass;
    case "user_banned":
      return Ban;
    case "role_changed":
      return UserCog;
    case "case_resolved":
      return CheckCheck;
    case "appeal_resolved":
      return Scale;
    default:
      return Activity;
  }
}

/**
 * The glyph a role carries in the team roster, rising with rank. Same
 * contract, fallback and element-not-component reasoning as
 * {@link actionIcon}.
 */
export function roleIcon(role: string): ReactNode {
  return createElement(roleIconComponent(role));
}

function roleIconComponent(role: string): LucideIcon {
  switch (role) {
    case "moderator":
      return Shield;
    case "staff":
      return ShieldCheck;
    case "admin":
      return Crown;
    default:
      return User;
  }
}
