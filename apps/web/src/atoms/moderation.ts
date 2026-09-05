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
import { orpc, type Post } from "@/lib/orpc";
import { FOLLOW_CACHE_KEYS } from "@/lib/follow-cache";
import { POST_CACHE_KEYS } from "@/lib/post-cache";
import {
  appealPreviewQueryOptions,
  auditLogQueryOptions,
  type CaseRef,
  moderationCaseQueryOptions,
  moderationQueueQueryOptions,
  teamQueryOptions,
  teamSearchQueryOptions,
} from "@/lib/query-definitions";
import { debounceMs } from "@/atoms/search";
import { isSignedInAtom } from "@/atoms/session";

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

/** One moderation queue; its cached pages are cleared with the QueryClient at sign-out. */
export const moderationQueueAtom = atomWithInfiniteQuery(() => moderationQueueQueryOptions());

/**
 * What the queue's header reads: how many cases are loaded, how many of them
 * carry an open appeal, and whether the server has more behind the cursor.
 *
 * Derived rather than computed in the view because the page header and the
 * queue list both want it, and a derived atom keeps the two off a second
 * `.pages.flatMap` that could drift. `loaded`/`hasMore` are deliberately
 * named for what they are — the queue is keyset-paginated, so this counts the
 * pages fetched so far, never a server-side total.
 */
export interface QueueSummary {
  /** Cases in the pages fetched so far. */
  loaded: number;
  /**
   * Open appeals across those cases — appeals, not cases carrying one: a
   * single target can have two open at once (one per control family), and
   * both are someone waiting on a reply.
   */
  appeals: number;
  /** Whether the server has at least one more page. */
  hasMore: boolean;
}

/** The queue's headline numbers — see {@link QueueSummary}. */
export const moderationQueueSummaryAtom = atom<QueueSummary>((get) => {
  const queue = get(moderationQueueAtom);
  const cases = queue.data?.pages.flatMap((page) => page.items) ?? [];
  return {
    loaded: cases.length,
    appeals: cases.reduce((total, item) => total + item.appeals.length, 0),
    hasMore: queue.hasNextPage,
  };
});

/** One audit log; its cached pages are cleared with the QueryClient at sign-out. */
export const auditLogAtom = atomWithInfiniteQuery(() => auditLogQueryOptions());

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

/** The value shown in the Team tab's account-lookup field — written on every keystroke. */
export const teamSearchInputAtom = atom("");

/** The value the lookup runs against — lags {@link teamSearchInputAtom} by `debounceMs`. */
export const debouncedTeamSearchAtom = atom("");

// Module-scoped rather than store-scoped, for the same reason as the
// SearchBox's timer in `atoms/search.ts` and safe on the same terms: the Team
// tab is one mount inside the moderation page, so at most one debounce is
// ever pending.
let teamSearchTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * The one entry point for typing into the Team tab's lookup. Writes the field
 * immediately; the query behind the results follows once typing has been
 * still for `debounceMs` — the same delay as the header search box, read from
 * it so the two fields cannot drift apart.
 */
export const setTeamSearchAtom = atom(null, (_get, set, q: string) => {
  set(teamSearchInputAtom, q);
  // Canonicalised here for the same reasons as `setSearchQueryAtom`: the
  // procedure trims its own input, so equivalent queries should share one
  // cache key and whitespace alone should stay disabled rather than becoming
  // a request the server must reject.
  const normalized = q.trim();
  clearTimeout(teamSearchTimer);
  teamSearchTimer = setTimeout(() => set(debouncedTeamSearchAtom, normalized), debounceMs);
});

/** Clears the pending debounce and both lookup values — the Team tab's unmount. */
export const resetTeamSearchAtom = atom(null, (_get, set) => {
  clearTimeout(teamSearchTimer);
  set(teamSearchInputAtom, "");
  set(debouncedTeamSearchAtom, "");
});

/**
 * The accounts matching the Team tab's lookup, whatever role they hold —
 * where a promotion starts, since the roster only lists accounts that already
 * have one (issue #145).
 *
 * A single atom rather than a family, like `typeaheadAtom`: the lookup is one
 * string, so there is nothing to key on, and `atomWithQuery` rebuilds the key
 * whenever the debounced value changes.
 */
export const teamSearchAtom = atomWithQuery((get) =>
  teamSearchQueryOptions(get(debouncedTeamSearchAtom)),
);

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

/**
 * The target a report dialog is open on. A post report carries the post
 * itself — already loaded in the feed cache when the kebab opened the dialog
 * — so the dialog can preview what is being flagged without a second fetch,
 * and without a fetch race against a post being removed between the card and
 * the dialog. A user report carries no post; there is nothing to preview.
 */
export type ReportDialogTarget =
  { targetType: "post"; targetId: string; post: Post } | { targetType: "user"; targetId: string };

/** Which report dialog is open: the target being reported, or null. */
export const reportDialogAtom = atom<ReportDialogTarget | null>(null);

/** Which block-confirm dialog is open: the user to block, or null. */
export const blockDialogAtom = atom<{ userId: string; handle: string } | null>(null);

/** Which set-role dialog is open: the team member whose role is changing, or null. */
export const setRoleDialogAtom = atom<{
  userId: string;
  handle: string;
  currentRole: string;
} | null>(null);

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

/**
 * The moderator's optional note on an appeal review, one draft per appeal.
 * Keyed by appeal id because a case can carry two open appeals at once (one
 * per control family), and each is reviewed with its own note — a single
 * shared draft would submit whichever text happened to be typed last with
 * whichever decision was clicked first. The draft itself derives nothing from
 * the id, so the initializer takes none: the family exists purely to give
 * each appeal its own instance.
 */
export const caseReviewNoteFamily = atomFamily(() => atom(""));

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
  // The review-note drafts are keyed per appeal; a case change orphans all of
  // them, so every existing entry is cleared rather than one named slot.
  for (const appealId of caseReviewNoteFamily.getParams()) {
    set(caseReviewNoteFamily(appealId), "");
  }
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
 * Every cache a post removal/restore rewrites. Shared by the removal, restore,
 * and appeal-overturn paths so they cannot drift apart — an appeal overturn
 * that restores a post must sweep the same surfaces as the removal's inverse.
 */
function invalidatePostCaches(queryClient: QueryClient): void {
  for (const queryKey of POST_CACHE_KEYS) {
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
      // stub appears), so every cached copy in feeds, threads and post search
      // must refetch.
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
      // The roster changes with the role; so does any lookup result showing
      // the role that just changed, which is where a promotion is picked from
      // in the first place. The swing is itself an audit row, so the shared
      // moderation sweep covers the log (issue #50).
      void queryClient.invalidateQueries({ queryKey: orpc.moderation.team.key() });
      void queryClient.invalidateQueries({ queryKey: orpc.moderation.searchUsers.key() });
      invalidateModerationQueries(queryClient);
    },
  });
});

/**
 * Encodes an appeal identifier into a family key — the kind FIRST and the
 * value last, so a value containing the delimiter still round-trips (the same
 * layout, for the same reason, as {@link encodeCaseKey}).
 */
export const encodeAppealKey = (identifier: { token?: string; postId?: string }): string =>
  identifier.token ? `token|${identifier.token}` : `postId|${identifier.postId ?? ""}`;

/**
 * The removed post behind one appeal identifier — what the appeal page renders
 * above its form.
 *
 * A family rather than a single atom because each appeal has its own query:
 * module-scope atoms take no parameters, and the page can be navigated from
 * one identifier to another. Signed-in state is read inside the atom so the
 * query starts itself the moment a session resolves, rather than staying
 * disabled from whatever was true at mount.
 */
export const appealPreviewFamily = atomFamily((key: string) =>
  atomWithQuery((get) => {
    const separator = key.indexOf("|");
    const kind = key.slice(0, separator);
    const value = key.slice(separator + 1);
    return appealPreviewQueryOptions(
      kind === "token" ? { token: value } : { postId: value },
      get(isSignedInAtom),
    );
  }),
);

/**
 * Opens an appeal — the app's one public surface, via capability token or a
 * signed-in removed post's stub.
 */
export const appealOpenAtom = atomWithMutation((get) => {
  const queryClient = get(queryClientAtom);
  return orpc.moderation.appealOpen.mutationOptions({
    onSuccess: () => {
      // The queue merges open appeals, so a successful submission must refetch
      // it (a no-op for a signed-out submitter with nothing mounted).
      void queryClient.invalidateQueries({ queryKey: orpc.moderation.queue.key() });
    },
  });
});

/**
 * Clears the appeal draft once a submission succeeds — the same
 * mount-time-effect pattern as the dialog resets above, consumed with
 * `useAtomValue`. The reset lives here rather than in `appealOpenAtom.onSuccess`
 * because that callback is handed only a Getter and cannot `set`; an
 * `atomEffect` runs inside the active Provider store, so the write lands where
 * the mutation ran (a module-scope `store.set` would miss a non-app Provider).
 * `isSuccess` is reset by the card's own remount on identifier change, so the
 * effect does not re-fire into a fresh form.
 */
export const resetAppealReasonEffect = atomEffect((get, set) => {
  if (get(appealOpenAtom).isSuccess) {
    set(appealReasonAtom, "");
  }
});

/**
 * Reviews one appeal: upholds the action or overturns it, each with its own
 * inverse + email. One mutation instance per appeal id — a case can carry two
 * open appeals at once, and a single shared slot would light every section's
 * pending/success/error state the moment any one of them was reviewed. The id
 * is also the mutation key, so each appeal's review is an identifiable entry
 * to the QueryClient rather than one anonymous slot.
 */
export const appealReviewFamily = atomFamily((appealId: string) =>
  atomWithMutation((get) => {
    const queryClient = get(queryClientAtom);
    return orpc.moderation.appealReview.mutationOptions({
      mutationKey: ["moderation", "appealReview", appealId],
      onSuccess: () => {
        // An overturn reverses one of three actions, and the result only says
        // "overturned" — not which — so sweep the union of the three inverses'
        // surfaces: a post removal (content comes back → post surfaces), a
        // suspension/ban (the user's content comes back app-wide → the full
        // visibility sweep), or a role change (the roster changes → team).
        invalidateVisibilityCaches(queryClient);
        void queryClient.invalidateQueries({ queryKey: orpc.moderation.team.key() });
        invalidateModerationQueries(queryClient);
      },
    });
  }),
);

/**
 * Removes every entry the moderation families have created — part of the
 * sign-out sweep (see `atoms/session-teardown.ts`), run while nothing is
 * mounted against them.
 */
export function clearModerationFamilies(): void {
  for (const key of caseFamily.getParams()) caseFamily.remove(key);
  for (const key of caseReviewNoteFamily.getParams()) caseReviewNoteFamily.remove(key);
  for (const key of appealReviewFamily.getParams()) appealReviewFamily.remove(key);
}
