import { atom } from "jotai";
import { atomFamily } from "jotai-family";
import { atomEffect } from "jotai-effect";
import {
  atomWithInfiniteQuery,
  atomWithMutation,
  atomWithQuery,
  queryClientAtom,
} from "jotai-tanstack-query";
import type { QueryClient } from "@tanstack/react-query";
import { store } from "@/lib/store";
import { orpc } from "@/lib/orpc";
import { FOLLOW_CACHE_KEYS } from "@/lib/follow-cache";
import { POST_CACHE_KEYS } from "@/lib/post-cache";
import {
  auditLogQueryOptions,
  type CaseRef,
  moderationCaseQueryOptions,
  moderationQueueQueryOptions,
  teamQueryOptions,
} from "@/lib/query-definitions";

/**
 * A reference to a moderation case target — what the queue rows hold, what the
 * dialogs carry, and the payload of `moderation.case`.
 */
export type { CaseRef } from "@/lib/query-definitions";

/** Encodes a case ref into a family key — the id LAST, so it may contain the delimiter (same layout as `encode` in `atoms/post-feed.ts`). */
export const encodeCaseKey = (ref: CaseRef): string => `${ref.targetType}|${ref.targetId}`;

/** Decodes a case family key back into a ref — the inverse of {@link encodeCaseKey}. */
export const decodeCaseKey = (key: string): CaseRef => {
  const [targetType = "post", ...rest] = key.split("|");
  return {
    // SAFETY: encodeCaseKey only ever writes the two literal target types.
    targetType: targetType as CaseRef["targetType"],
    targetId: rest.join("|"),
  };
};

/**
 * One infinite-query atom per queue scope, shared by every component that
 * reads that scope — the same structural-dedup reasoning as `postFeedFamily`
 * in `atoms/post-feed.ts`. There is exactly one queue today, so the key is
 * always `""`; the family exists so the sign-out sweep and a future filter
 * (post vs user cases) do not require a migration.
 */
const queueFamily = atomFamily(() => atomWithInfiniteQuery(() => moderationQueueQueryOptions()));

/** The infinite-query atom for the moderation queue — components read this, not the family. */
export const moderationQueueAtom = queueFamily("");

/**
 * One infinite-query atom per audit-log scope — same reasoning as
 * `queueFamily`; the key is always `""` today.
 */
const auditLogFamily = atomFamily(() => atomWithInfiniteQuery(() => auditLogQueryOptions()));

/** The infinite-query atom for the audit log — components read this, not the family. */
export const auditLogAtom = auditLogFamily("");

/**
 * One query atom per case. Keyed on the case ref (encoded) so the queue rows
 * that open the case dialog and the dialog's own refetch share a single
 * observer — an action invalidating `moderation.case` refreshes exactly the
 * open case.
 */
const caseFamily = atomFamily((key: string) =>
  atomWithQuery(() => moderationCaseQueryOptions(decodeCaseKey(key))),
);

/** The query atom for one moderation case — components read this, not the family. */
export const caseAtom = (ref: CaseRef) => caseFamily(encodeCaseKey(ref));

/** The moderation team roster, for the staff-only Team tab. */
export const teamAtom = atomWithQuery(() => teamQueryOptions());

/**
 * The viewer's blocked users, newest block first — what the settings page's
 * "Blocked users" section renders. Not a family: one list per viewer, wiped
 * with the QueryClient on sign-out like every other non-family query.
 */
export const blockedUsersAtom = atomWithQuery(() => orpc.moderation.listBlocked.queryOptions());

/**
 * Which moderation case dialog is open, app-wide — at most one. Same
 * identity-holding reasoning as `followListDialogAtom` in `atoms/user-list.ts`:
 * the queue view renders the dialog conditionally off this value, so there is
 * no per-instance boolean to reconcile.
 */
export const caseDialogAtom = atom<CaseRef | null>(null);

/** Which report dialog is open: the target being reported, or null. */
export const reportDialogAtom = atom<CaseRef | null>(null);

/** Which block-confirm dialog is open: the user to block, or null. */
export const blockDialogAtom = atom<{ userId: string; handle: string } | null>(null);

/** Which set-role dialog is open: the team member whose role is changing, or null. */
export const setRoleDialogAtom = atom<{ userId: string; handle: string } | null>(null);

/** The suspension length the case dialog offers first: 24 hours. */
export const DEFAULT_SUSPENSION_SECONDS = 24 * 60 * 60;

/** The selected report reason in the report dialog — reset whenever it opens. */
export const reportReasonAtom = atom("");

/** The reason attached to a post removal, shown to the author in the stub. */
export const caseRemoveReasonAtom = atom("");

/** The moderator's optional note on a dismissal. */
export const caseDismissNoteAtom = atom("");

/** The reason attached to a suspension, shown to the user in their email. */
export const caseSuspendReasonAtom = atom("");

/** The suspension length in seconds, one of the preset durations. */
export const caseSuspendDurationAtom = atom(DEFAULT_SUSPENSION_SECONDS);

/** The reason attached to a ban, shown to the user in their email. */
export const caseBanReasonAtom = atom("");

/** The moderator's optional note on an appeal review. */
export const caseReviewNoteAtom = atom("");

/** The role picked in the set-role dialog — "" until one is chosen. */
export const roleSelectAtom = atom("");

/** The appeal page's draft text — reset on successful submission. */
export const appealReasonAtom = atom("");

/**
 * Resets the case-dialog form fields whenever the open case changes. The
 * dialog is conditionally mounted per case (see `caseDialogAtom`), so this
 * runs once per open — the same mount-time-effect pattern as the reactions
 * mounted with `useAtomValue` elsewhere.
 */
export const resetCaseFormEffect = atomEffect((get, set) => {
  get(caseDialogAtom);
  set(caseRemoveReasonAtom, "");
  set(caseDismissNoteAtom, "");
  set(caseSuspendReasonAtom, "");
  set(caseSuspendDurationAtom, DEFAULT_SUSPENSION_SECONDS);
  set(caseBanReasonAtom, "");
  set(caseReviewNoteAtom, "");
});

/** Resets the report dialog's reason when a new target is picked. */
export const resetReportFormEffect = atomEffect((get, set) => {
  get(reportDialogAtom);
  set(reportReasonAtom, "");
});

/** Resets the set-role dialog's pick when a new member is chosen. */
export const resetRoleFormEffect = atomEffect((get, set) => {
  get(setRoleDialogAtom);
  set(roleSelectAtom, "");
});

/**
 * Refetches every moderation query the queue, case and audit views read —
 * every audit-writing action must show up in the audit log (`logAction` is
 * the one writer of `moderation_action` rows), and every action here changes
 * the queue or the open case. The prefix keys cover the family entries.
 */
function invalidateModerationQueries(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: orpc.moderation.queue.key() });
  void queryClient.invalidateQueries({ queryKey: orpc.moderation.case.key() });
  void queryClient.invalidateQueries({ queryKey: orpc.moderation.auditLog.key() });
}

/**
 * Every cache whose content `visibility.ts`'s predicate filters — the
 * surfaces where a banned account (`effectivelyBanned`) or a blocked pair
 * (either direction) disappears: feeds, threads, search, typeahead, follow
 * lists, and the profile being viewed. Block/unblock change the block half of
 * the predicate; ban/suspend/unban change the ban half — two relationship
 * kinds, one set of surfaces, so one sweep is what stops them drifting again
 * (issue #50). `listBlocked` rides along: it is the viewer's
 * block-relationship list, changed only by block/unblock, and the refetch a
 * ban triggers returns identical data — but keeping it inside the sweep is
 * the only thing that stops the block side from forking off the helper.
 *
 * The list is composed rather than re-listed: every one of these surfaces is
 * owned by `post-cache.ts` or `follow-cache.ts` (they hold the same cached
 * shapes this predicate filters), so pointing at their inventories keeps the
 * two copies from drifting apart (issue #127) — when one of those modules
 * gains a cache, this sweep gains it too. Only the two surfaces no cache
 * module writes — typeahead suggestions and the block list itself — are
 * listed here.
 */
const VISIBILITY_CACHE_KEYS = [
  ...POST_CACHE_KEYS,
  ...FOLLOW_CACHE_KEYS,
  orpc.search.typeahead.key(),
  orpc.moderation.listBlocked.key(),
];

function invalidateVisibilityCaches(queryClient: QueryClient): void {
  for (const queryKey of VISIBILITY_CACHE_KEYS) {
    void queryClient.invalidateQueries({ queryKey });
  }
}

/**
 * Every cache a post removal/restore rewrites: the three post shapes
 * (`POST_CACHE_KEYS`) plus the typeahead, which also surfaces posts. Shared by
 * the removal, restore, and appeal-overturn paths so they can't drift apart —
 * an appeal overturn that restores a post must sweep the same surfaces the
 * removal's inverse does, or a stale tombstone lingers in search/typeahead.
 */
const POST_SURFACE_KEYS = [...POST_CACHE_KEYS, orpc.search.typeahead.key()];

function invalidatePostCaches(queryClient: QueryClient): void {
  for (const queryKey of POST_SURFACE_KEYS) {
    void queryClient.invalidateQueries({ queryKey });
  }
}

/** Reports a post or user for one of the stable reason codes (issue #38). */
export const reportAtom = atomWithMutation((get) => {
  const queryClient = get(queryClientAtom);
  return orpc.moderation.report.mutationOptions({
    onSuccess: () => {
      // A report writes `report` rows, not `moderation_action` rows — it
      // moves the queue (a new case, or a resolved one reopens) and any
      // open case dialog's report list, so the reporter's own views must
      // refetch (issue #50). The audit-log refetch the shared sweep also
      // triggers is a no-op: no audit row was written.
      invalidateModerationQueries(queryClient);
    },
  });
});

/** Blocks a user: their posts leave the viewer's feeds and both follows are severed. */
export const blockAtom = atomWithMutation((get) => {
  const queryClient = get(queryClientAtom);
  return orpc.moderation.block.mutationOptions({
    onSuccess: () => invalidateVisibilityCaches(queryClient),
  });
});

/** Unblocks a user — the mirror of {@link blockAtom}, same cache sweep. */
export const unblockAtom = atomWithMutation((get) => {
  const queryClient = get(queryClientAtom);
  return orpc.moderation.unblock.mutationOptions({
    onSuccess: () => invalidateVisibilityCaches(queryClient),
  });
});

/** Removes a post and stamps its open reports `actioned`. */
export const removePostAtom = atomWithMutation((get) => {
  const queryClient = get(queryClientAtom);
  return orpc.moderation.removePost.mutationOptions({
    onSuccess: () => {
      // The tombstone rewrites the post for every viewer (content nulls, the
      // stub appears), so every cached copy — feeds, threads, search, the
      // typeahead — must refetch.
      invalidatePostCaches(queryClient);
      invalidateModerationQueries(queryClient);
    },
  });
});

/** Restores a removed post — the removal's own inverse, and the appeal-overturn path. */
export const restorePostAtom = atomWithMutation((get) => {
  const queryClient = get(queryClientAtom);
  return orpc.moderation.restorePost.mutationOptions({
    onSuccess: () => {
      invalidatePostCaches(queryClient);
      invalidateModerationQueries(queryClient);
    },
  });
});

/** Resolves a case without acting on the target: stamps reports, emails reporters. */
export const resolveAtom = atomWithMutation((get) => {
  const queryClient = get(queryClientAtom);
  return orpc.moderation.resolve.mutationOptions({
    onSuccess: () => invalidateModerationQueries(queryClient),
  });
});

/** Suspends a user for a set duration, ending their sessions. */
export const suspendUserAtom = atomWithMutation((get) => {
  const queryClient = get(queryClientAtom);
  return orpc.moderation.suspendUser.mutationOptions({
    onSuccess: () => {
      invalidateModerationQueries(queryClient);
      // The suspension hides the target from every viewer (`effectivelyBanned`
      // in visibility.ts), not just the acting moderator — so their own
      // feeds and follow caches need the same sweep a block runs (issue #50).
      invalidateVisibilityCaches(queryClient);
    },
  });
});

/** Bans a user indefinitely (staff). */
export const banUserAtom = atomWithMutation((get) => {
  const queryClient = get(queryClientAtom);
  return orpc.moderation.banUser.mutationOptions({
    onSuccess: () => {
      invalidateModerationQueries(queryClient);
      // A ban is `effectivelyBanned` app-wide — the same predicate family a
      // block flips, so the same sweep (issue #50).
      invalidateVisibilityCaches(queryClient);
    },
  });
});

/** Lifts a suspension or ban (staff). */
export const unbanUserAtom = atomWithMutation((get) => {
  const queryClient = get(queryClientAtom);
  return orpc.moderation.unbanUser.mutationOptions({
    onSuccess: () => {
      invalidateModerationQueries(queryClient);
      // Lifting the sentence brings the content back app-wide — the inverse
      // of the ban sweep (issue #50).
      invalidateVisibilityCaches(queryClient);
    },
  });
});

/** Changes a team member's role (rank-checked by the server). */
export const setRoleAtom = atomWithMutation((get) => {
  const queryClient = get(queryClientAtom);
  return orpc.moderation.setRole.mutationOptions({
    onSuccess: () => {
      // The roster changes with the role; the swing is itself an audit row,
      // so the shared moderation sweep covers the log (issue #50).
      void queryClient.invalidateQueries({ queryKey: orpc.moderation.team.key() });
      invalidateModerationQueries(queryClient);
    },
  });
});

/**
 * Opens an appeal — the app's one public surface, via capability token or a
 * signed-in removed post's stub.
 */
export const appealOpenAtom = atomWithMutation((get) => {
  const queryClient = get(queryClientAtom);
  return orpc.moderation.appealOpen.mutationOptions({
    onSuccess: () => {
      // Same pattern as `createPostAtom` (atoms/composer.ts): the draft reset
      // goes through the module-scope store, which `onSuccess` can reach, so
      // the next appeal starts blank.
      store.set(appealReasonAtom, "");
      // The queue merges open appeals, so a successful submission must refetch
      // it (a no-op for a signed-out submitter with nothing mounted).
      void queryClient.invalidateQueries({ queryKey: orpc.moderation.queue.key() });
    },
  });
});

/** Reviews an appeal: upholds the action or overturns it, each with its own inverse + email. */
export const appealReviewAtom = atomWithMutation((get) => {
  const queryClient = get(queryClientAtom);
  return orpc.moderation.appealReview.mutationOptions({
    onSuccess: () => {
      // An overturn restores the target, so the same sweep as the inverses
      // themselves — content may have come back or a suspension lifted.
      invalidatePostCaches(queryClient);
      invalidateModerationQueries(queryClient);
    },
  });
});

/**
 * Removes every entry the moderation families have created — part of the
 * sign-out sweep (see `atoms/session-teardown.ts`), run while nothing is
 * mounted against them.
 */
export function clearModerationFamilies(): void {
  for (const key of queueFamily.getParams()) queueFamily.remove(key);
  for (const key of auditLogFamily.getParams()) auditLogFamily.remove(key);
  for (const key of caseFamily.getParams()) caseFamily.remove(key);
}
