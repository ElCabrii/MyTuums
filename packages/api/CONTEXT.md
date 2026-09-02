# packages/api context

## Responsibility

The oRPC contract and the business rules behind it: every procedure the server
mounts at `/rpc`, plus the pure logic they are built from — keyset cursors,
rate-limit policies, image acceptance, media URLs, the role hierarchy, the
visibility filters and the moderation effects.

Source-only: tsup inlines it into the server bundle. The web app talks to it
over HTTP and imports only its browser-safe subpaths.

## Start here

| File                        | Why                                                                                                                                                                                      |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/router.ts`             | The six groups and what owns each.                                                                                                                                                       |
| `src/procedures.ts`         | The four gates, the legal consent and onboarding gates, the two rate-limit mechanisms, the one exception.                                                                                |
| `src/context.ts`            | What every handler is handed, and why nothing is a module global.                                                                                                                        |
| `src/pagination.ts`         | The keyset skeleton every paginated list is built from.                                                                                                                                  |
| `src/visibility.ts`         | The one filter that keeps banned and blocked content from leaking.                                                                                                                       |
| `src/notifications.ts`      | The notification read side (list, unread count, mark-read) and `insertNotification`, the single mint point every cause's transaction calls.                                              |
| `src/moderation-actions.ts` | The forward and inverse moderation effects: transaction, guards, audit, owed notices. The one entry point (`applyModerationEffect`) and the per-action wrappers own "commit, then send". |
| `src/appeal-intake.ts`      | The appeal intake lifecycle: the two sources, the budgets, the gates, the replay policy.                                                                                                 |
| `src/profile-media.ts`      | The avatar/banner lifecycle: replace/remove, the locked swap, best-effort cleanup.                                                                                                       |

## Change map

| Intent                                | Primary                                                                                           | Also touch                                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Add a procedure                       | the group's file (`src/posts.ts`, `src/users.ts`, `src/search.ts`, `src/moderation*.ts`)          | `src/router.ts` if it is a new group; an `.int.test.ts`                                                  |
| Add a paginated list                  | `src/pagination.ts` (`keysetPage`) at the call site                                               | a matching index in `packages/db/src/schema/app.ts`                                                      |
| Change a rate limit                   | `src/rate-limit.ts` (`RATE_LIMITS`)                                                               | `src/rate-limit.test.ts`                                                                                 |
| Change the public profile shape       | `src/users.ts` (`publicUserColumns`)                                                              | `src/users.int.test.ts` pins the invariant first                                                         |
| Add a moderation action               | `src/moderation-actions.ts` (the effect) and `src/moderation.ts` (the procedure)                  | `src/constants.ts` (action code), `docs/product.md` glossary                                             |
| Change the queue or a case view       | `src/moderation-queue.ts`                                                                         | `src/moderation-inputs.ts` if the input shape moves                                                      |
| Change how a user is matched by text  | `src/search.ts` (`matchesUserQuery`, `userQueryRank`)                                             | all three search surfaces share matching; typeahead and `moderation.searchUsers` share relevance ranking |
| Change how an appeal is opened        | `src/appeal-intake.ts` (`openAppeal`), `src/appeal-token.ts`                                      | `src/appeal-intake.int.test.ts`; `docs/security.md` — this is the one anonymous surface                  |
| Change how an appeal is reviewed      | `src/moderation-appeals.ts` (`appealReview`)                                                      | `src/moderation-actions.ts` if the inverse effect changes                                                |
| Change what an appellant is shown     | `src/moderation-appeals.ts` (`appealPreview`), `src/post-media.ts` (`canViewPostMedia`)           | `src/appeal-preview.int.test.ts`, `src/post-media.int.test.ts`; `docs/security.md` — media retrieval     |
| Change profile-image upload rules     | `src/image.ts`, `src/constants.ts` (`IMAGE_LIMITS`)                                               | `src/image.test.ts`; `src/dimensions.ts` for a new format                                                |
| Change post-attachment upload rules   | `src/post-image.ts`, `src/constants.ts` (`POST_ATTACHMENT_*`)                                     | `src/image.test.ts`; `src/posts.int.test.ts`                                                             |
| Change the profile upload lifecycle   | `src/profile-media.ts`                                                                            | `src/profile-media.int.test.ts`; `src/users.ts` only if the procedure shape changes                      |
| Change the post attachment lifecycle  | `src/post-media.ts`, `src/post-media-lock.ts`                                                     | `src/posts.int.test.ts`; `src/reconcile-media.ts`; `scripts/reconcile-media.ts`                          |
| Change follow, block or unblock       | `src/users.ts`, `src/moderation.ts`                                                               | `src/relationship-lock.ts` — every relationship writer must take the pair lock                           |
| Change the notifications read side    | `src/notifications.ts`                                                                            | `src/notifications.int.test.ts`; the read-time filters live with the table in `packages/db`              |
| Change when an event notifies         | the cause's own file (`src/posts.ts`, `src/users.ts`, `logAction` in `src/moderation-actions.ts`) | `insertNotification` is the only mint point, and it rides the cause's transaction                        |
| Change media URLs or caching          | `src/media.ts`, `src/storage.ts`                                                                  | `apps/server/src/request-handler.ts`                                                                     |
| Change the link-card wire rules       | `src/link-card-http.ts`                                                                           | `src/link-card-http.test.ts`                                                                             |
| Purge or re-serve link cards          | `src/link-card.ts` (`resolveLinkCard`, `purgeLinkCard`)                                           | `src/moderation.ts` (the procedure); `link-card.int.test.ts`                                             |
| Add a shared constant for the web app | `src/constants.ts`                                                                                | must stay free of `@my-tuums/db`                                                                         |
| Change an account rule                | `../auth/src/rules.ts`                                                                            | not `src/constants.ts` — see the invariant below                                                         |

## Invariants

- **The rate limiter, storage client, and email sender are threaded on `Context`,
  never module globals.** Tests substitute all three; one suite's limiter state
  must not bleed into another's, and moderation tests record delivery through
  the same sender interface production uses.
- **`rateLimit` keys on `user:<id>`; `rateLimitCapability` keys on a
  capability.** Do not describe limiting here as uniformly per-user.
  `rateLimitCapability` is what throttles `moderation.appealOpen`
  (`appeal:<nonce>` or `appeal:<actionId>`) and is deliberately not a
  middleware — the key only exists after the handler's own branch work.
- **`baseProcedure` has exactly one consumer.** `moderation.appealOpen` is the
  app's one anonymous surface, and it is HMAC-capability-gated because a
  banned user cannot sign in to appeal. Anything else built on it is a bug.
  `moderation.appealPreview` is the deliberate counter-example: it serves the
  same page from `protectedProcedure`, because a post removal suspends nobody,
  so its author can always sign in — and requiring that session is what lets
  the attachments come back through the ordinary `/media/` route instead of
  needing a second anonymous way to reach object storage.
- **`protectedProcedure` carries the legal consent gate.** An account whose
  recorded acceptance is absent or names a superseded version is refused
  FORBIDDEN, because `packages/auth`'s create hook can only cover
  `/sign-up/email` — an OAuth or passkey sign-up has nowhere to put a
  checkbox, so those accounts exist before anyone can be asked. It lives on
  the gate every procedure is built from rather than on the ones someone
  remembered to mark, and `hasCurrentLegalConsent` in `@my-tuums/auth/rules`
  is the single reader the web dialog shares. Accepting, the `/welcome` claim,
  signing out and reading the documents all run outside oRPC, which is what
  keeps the gate from locking out the very people it is asking.
- **`protectedProcedure` also carries the onboarding gate.** An OAuth or
  passkey account lands with neither a claimed handle nor a date of birth, and
  the client-side `/welcome` redirect is a courtesy anyone can skip — so the
  gate refuses FORBIDDEN until `hasCompletedOnboarding` (in
  `@my-tuums/auth/rules`) reads both off the session user, re-using the same
  15+ parse and boundary as the write hook. The `/welcome` claim still runs
  through `authClient.updateUser` outside oRPC, and `appealOpen` builds from
  `baseProcedure`, so neither the people the gate is asking nor the banned
  accounts that must be heard are locked out.
- **Appeal intake lives in `src/appeal-intake.ts`, and only there.**
  `moderation.appealOpen` validates its input shape and calls `openAppeal`;
  it owns nothing else. The module treats the email link and the removed-post
  stub as two source adapters — each authenticates its own claim and spends
  its own capability budget (`appeal:<nonce>`, `appeal:<actionId>`) — and
  normalises both to one target, after which the appealable/current/latest
  gates, the replay policy and the insert are source-blind. The ordering is
  load-bearing: the HMAC comparison happens before any database work, each
  budget is consumed at the exact point its key comes into existence, and the
  common tail locks the contested `moderation_action` through validation and
  insert. Intake never sends a notice and never reverses an action — that is
  `appealReview`'s half, in `src/moderation-appeals.ts`.
- **Appeal intake is exactly-once at two layers.** The action-row lock
  serializes concurrent application opens before their replay read. The
  unique `token_nonce` and partial unique open-per-action indexes remain the
  database authority for outside writers and collisions; `isUniqueViolation`
  walks Drizzle's wrapped `cause` chain so a constraint rejection still reads
  as a caller-facing refusal.
- **User matching has one definition.** `matchesUserQuery` in `src/search.ts`
  is what "this account matches what you typed" means — a left-anchored match
  on the normalised `username`, or a substring of either display field.
  `search.typeahead`, `search.users` and `moderation.searchUsers` all filter
  through it, so widening a match lands on all three instead of drifting.
  The two bounded lookup surfaces (`search.typeahead` and
  `moderation.searchUsers`) also share `userQueryRank`: exact handle, other
  handle prefixes, then display-only matches. `search.users` deliberately
  keeps its `(createdAt, id)` keyset order instead of relevance ranking. What
  the moderation lookup does not share is the visibility filter: it is a
  staff surface that has to reach a banned or blocked account, and it returns
  `role` for the same reason `team` does — the caller cannot tell whether it
  may manage a target without it.
- **`publicUserColumns` is a privacy boundary.** Never add `email`,
  `twoFactorEnabled`, `lastLoginMethod`, `role` or a preference column; sign-in
  method is reconnaissance, not profile data. `src/users.int.test.ts` pins the
  exact shape.
- **Every surface filters through `src/visibility.ts`.** `invisibleUser` is the
  stricter of the two per-user filters — it is what lets a banned-but-not-blocked
  profile resolve to its suspended stub instead of 404ing. `user.byUsername`
  redacts authored profile fields, relationship counts and viewer state from
  that stub before it crosses the API boundary.
- **`like`/`unlike`, `repost`/`unrepost`, `bookmark`/`unbookmark` and
  `follow`/`unfollow` are separate idempotent procedures, never a toggle** —
  ordering and retry safety. A bookmark is the private twin of a like: the
  composite `post_bookmark` primary key is the one-row rule,
  `postSelection`'s `viewerHasBookmarked` probe is its only read besides the
  saver's own `post.list({ feed: "bookmarks" })` page, and no count is ever
  derived from the table. That page is a mode of `post.list` (keyset on the
  bookmark's `(created_at, post_id)`, mirrored by
  `post_bookmark_user_created_idx`), so it shares the projection, the feed
  rules — author-deleted posts omitted, removals stubbed, visibility
  filtered — and the web app's optimistic sweeps. `unbookmark` deliberately
  carries no target visibility check, unlike `bookmark`: the row it deletes
  is the caller's own, its response is the same for a missing and an
  invisible post, and the page's visibility filter hides exactly the saves
  that would otherwise be stranded — unremovable from the page that no
  longer renders them.
- **A notification is minted only inside the transaction of the event that
  caused it, and exactly-once is the cause's own idempotency** (issue #259).
  `post.like`, `post.repost` and `user.follow` insert their notification only
  when the `.returning()` of the cause's `onConflictDoNothing` insert is
  non-empty, so a retry mints nothing while like → unlike → like is honestly
  three events and an unrepost removes nothing (rows are historical); a
  reply's or quote's notification rides `insertPost`'s transaction pointing
  at the new post itself (the quote's recipient is the quoted author); and
  the moderation half lives in `logAction`'s optional `notifyUserId`, which
  every effect passes — the locked, guarded paths that keep the audit log
  append-only are what keep it exactly-once, with a null actor because the
  branded email never names the moderator either.
  `case_resolved` deliberately passes none: its notices go to the reporters,
  and email stays that channel. The silence is enumerated too: edits never
  notify (an edit is not an event about the recipient), bookmarks never
  notify (private by design; no emission point exists), and link-card
  fetches and purges never notify (not actions on a person; the purge audit
  trail lives on `link_card` by design). The read side
  (`src/notifications.ts`) owns
  the rest: self-caused events are dropped in `insertNotification` (the
  `notification_not_self` check constraint would otherwise abort the cause
  transaction with it), and the list and the unread count share one
  visibility predicate — moderation rows always show, every other row only
  while its actor is visible to the recipient (which also drops user-caused
  rows whose actor was hard-deleted; the FK is set-null so moderation rows
  survive), and a row about an author-deleted post stops surfacing, the same
  tombstone treatment the reply feed gives deleted replies. Read state is a
  per-recipient seen-at cursor (`notification_last_seen`), not a per-row
  stamp: a row is read exactly when its `created_at` is at or before the
  cursor, `markRead` is one idempotent upsert, and no notification is ever
  _born_ read — what the recipient has and has not seen stays truthful. A
  same-type burst from one actor is damped in the badge, not in the rows:
  `unreadCount` counts one tick per actor, type and minute bucket (moderation
  rows each count; they are never damped), so like → unlike → like cycling
  cannot pump the badge faster than one tick per actor-minute while the page
  still lists — and shows unread — every event. The bucketing is best-effort
  by design — two same-type events straddling a bucket boundary can tick
  twice — a damper, not an invariant. The list and the badge share one
  visibility predicate _and_ one retention horizon
  (`NOTIFICATION_RETENTION_DAYS`; moderation rows exempt on both sides), so
  the badge can never show a number the page behind it cannot reconcile;
  `pnpm --filter @my-tuums/api prune:notifications` deletes rows past that
  same horizon and never deletes read cursors — moderation rows being
  exempt means a recipient returning past the horizon still has retained
  rows to show, and their cursor is what keeps those notices read (one row
  per recipient is nothing).
- **Relationship writes for a pair are serialized by one advisory lock.**
  "A blocked pair has no follow edge" spans `follow` and `user_block`, so no
  database constraint can hold it. `follow`, `block` and `unblock` all take
  `acquireRelationshipLock` (`src/relationship-lock.ts`) on the _unordered_
  pair, inside the transaction that does the write. Unlocked, `follow`'s block
  check and its insert straddle a concurrent `block`: the block severs the
  existing edges, `follow` inserts a new one, and a prohibited edge stands
  behind the block until the unblock puts it back in view. Any future writer
  of either table must take the same lock — the key must come from the sorted
  pair, or the two directions would take different locks and never meet.
- **A post has two independent tombstones, and neither is a row delete.**
  `moderation.removePost` stamps `removed_at`; `post.delete` (the author's own,
  issue #148) stamps `deleted_at`. `postSelection` nulls the content for
  either — including for the author, which is why `moderation.appealPreview`
  exists to hand the author back their own removed post — and `search.posts`
  excludes both rows outright — it matches the raw
  `content` column, which no projection touches, so a tombstoned post's text
  would otherwise stay probeable. `post.list` also excludes author-deleted
  rows (including compact reply-parent previews), while `post.thread` keeps
  their focused/ancestor stubs. Keeping the row is what lets replies, likes and
  the thread above survive, and it is why `post.parent_id` can still cascade.
  `post.delete` is deliberately NOT a moderation effect: no
  transaction, no `FOR UPDATE`, no `moderation_action` row, no email, nothing
  appealable — it is author-owned and idempotent, and it refuses a post a
  moderator already removed so the author keeps the stub's reason and appeal
  link. The moderation effects make the inverse check too: a deleted post is
  refused before `post_removed` or `post_restored` can be logged, including a
  legacy row that happens to carry both tombstones. The refusal goes through
  `refuseIfAuthorDeleted`, which first stamps the post's open appeals
  `withdrawn` in its own committed transaction — the appellant is the author,
  so their deletion ends the grievance, and an appeal that could be upheld but
  never overturned must not sit open in the queue. That pre-check runs outside
  the effect transaction (a thrown refusal would roll it back); it is idempotent
  and re-run on every attempt, while the effects' locked guards remain the
  authority on whether the operation itself proceeds. Its unlocked read/write
  pair is safe because the update compares both tombstones; after losing to a
  concurrent delete or removal, it re-reads the winner and preserves that
  outcome.
- **`post.edit` rewrites text and nothing else (issue #264).** The body field
  is the shared `postContentInput` — the same trim and bound `post.create`
  enforces, never restated — and attachments are immutable through it; the
  create cross-field rule (text, images, or both) is re-checked against the
  row's existing attachments, so clearing the text of an image post is a legal
  edit while emptying a text-only post is refused with create's own message.
  It is author-owned and idempotent like `post.delete`: a content-equal retry
  keeps the original `edited_at` (the marker never restamps, and no history
  row is written), and the state guards refuse even for a content-equal
  retry. Two states refuse an edit: moderator-removed (the appeal story must
  not mutate — `moderation.appealPreview` quotes that row's content) and
  author-deleted. Editing deliberately stays OPEN under active moderation
  review: instead of freezing the text, every edit records the version it
  superseded in `post_edit` (stamped with the same instant as `edited_at`),
  and `moderation.case` returns that history beside the current text —
  moderator-gated, no public surface reads it, capped at the newest 50 rows
  (`EDIT_HISTORY_CASE_LIMIT`) with an `editHistoryTruncated` flag. The
  evidence is doubled: a post report snapshots the content it was raised
  against (`report.snapshot_content`, refreshed on a repeat report), so a
  rewrite mid-case or after a dismissal can hide what was judged through
  neither the snapshot nor the history. The same claim covers the quote shape
  (issue #264 meets #261): a quote case is judged against the ORIGINAL's
  wording too, but the report snapshots belong to the quoting post — the
  original may never have been reported itself — so `moderation.case` also
  returns the quoted original's own `post_edit` history (same cap, same
  helper) spliced into the `quoted` evidence beside its live content, and a
  rewrite of the original after being quoted is no more hiding than a rewrite
  of the target. That is also why the write opens
  with `SELECT … FOR UPDATE` where `post.delete` needs no lock: concurrent
  editors serialize on the row, so each history row records the text its
  edit _actually_ superseded and no version can be lost between two
  overlapping edits — an unlocked pair would record the same superseded
  text twice and the first edit's wording would survive nowhere.
  `created_at` never moves, so feeds and search pick up the new text with no
  re-ranking. `edited_at` rides `postSelection` beside `createdAt`.
- **Reposts and quote posts are events and references, never posts (issue
  #261).** A repost is a `post_repost` row — the same idempotent
  `repost`/`unrepost` pair, composite-PK idempotency and derived count as
  `like`/`unlike` — so "reposting a repost" has no expressible target: every
  action names an original post id. A quote is a post row plus `quotedPostId`
  (deliberately FK-less, the evidence-retention pattern of `report.targetId`:
  hard-deleting the quoted post must not cascade the quoter's own post away),
  carrying every post rule and rendering its embedded `quoted` preview in
  every context through `postSelection` — feed, permalink, thread, search —
  plus the moderator's raw-content variant (`quotedPostEvidence`) in
  `moderation.case`. The degradation matrix is decided and pinned in
  `src/reposts.int.test.ts`: author-deleted original → deletion stub in place
  of the embedded post (the repost event stays in the feed; the quote's own
  text survives); moderator-removed original → removal stub, with
  `removedReason` author-only as everywhere; banned/blocked original author →
  a quote's embedded post is null, while a repost keeps the visible reposter's
  event with an `unavailable` original whose identity, content, media, counts
  and interactions are redacted.
- **The home feeds walk a merged event timeline.** `post.list` without
  `parentId` unions authored posts with repost events (`feedEventPage` in
  `src/posts.ts`), strictly reverse-chronological by event time — a repost
  places the original at the repost's timestamp — with no ranking and no
  deduplication: one post can be two events. The event cursor is a three-part
  key (`createEventCursorCodec` in `src/cursor.ts`): `(event_at, post_id,
reposter_key)`, where the reposter half is absent for post events and binds
  as `''` in SQL so the row-value comparison stays a total order. Reply lists
  (`parentId`) run no repost arm: they are direct replies by their own event
  time. A profile feed (`authorId`) runs the arm only when the caller opts in
  through `includeReposts`, scoped to the profile's own `post_repost.user_id`
  rows (issue #277) — a profile carries the events its owner caused, never
  other people's amplifications of the owner's posts — and `post_repost_user_created_idx`
  mirrors that walk. The same rule excludes reposts _of_ replies under
  `kind: "posts"` — the Posts tab is top-level only, like the home timelines —
  and the web hides the repost control on replies rather than offer an
  action no shipped surface creates. The repost arm applies the block/ban
  filter to the reposter
  (`aliasVisibleTo` — `invisibleAuthor` is bound to the un-aliased table), but
  deliberately keeps a visible reposter's event when only the original author
  is hidden; the projection phase re-evaluates that original and emits the
  redacted `unavailable` shape.
- **Replies and their inline continuations are modes of `post.list`, not
  separate procedures.** `parentId` remains the keyset-paginated owner of a
  focused post's direct replies; those pages add the bounded original-author
  continuation for each returned direct row. `continuationRootId` resumes one
  capped branch in place. Keeping both under `post.list` means the web app's
  optimistic like/deletion/moderation sweep reaches direct and continuation
  rows through one query prefix. `src/reply-branch.ts` owns the deterministic
  rule: choose the earliest descendant by the focused author, include its path,
  then follow the oldest child at each fork. The descendant scan that feeds it
  is bounded in `posts.ts`: each fork expands only its oldest
  `THREAD_REPLY_BRANCH_CHILD_FANOUT` children, recursion stops at
  `THREAD_REPLY_BRANCH_MAX_DEPTH`, and the total output is capped at
  `THREAD_REPLY_BRANCH_DESCENDANT_BUDGET` rows — so a broad tree can never make
  a permalink scan the whole forest or push the metadata lookup's parameter
  list past PostgreSQL's limit. `kind` still selects top-level posts, replies,
  or both, while `includeReplies` remains the compatibility spelling for both.
- **Posts and replies share one attachment policy.** Either may carry up to
  four ordered PNG, JPEG, or WebP files. Each file is capped at 5 MiB, the
  batch at 12 MiB, and decoded dimensions at 4096 px per side / 50 MP. The
  server validates actual bytes and persists only server-minted `/media/posts/`
  paths in `post_attachment`; `postSelection` is the authoritative projection
  for every reader. Ordinary media reads follow post tombstones, author bans,
  and blocks, while moderators retain access to removed evidence. Author
  deletion removes the non-restorable relation and objects; failed writes and
  hard account cascades are reaped by `reconcile-media`.
- **The profile-media lifecycle lives in `src/profile-media.ts`, and only
  there.** `user.uploadImage` and `user.removeImage` call
  `replaceProfileMedia`/`removeProfileMedia` and own nothing else: the
  prepare-write-swap-discard ordering, the `FOR UPDATE` row lock, the
  avatar/banner pair-key mapping and the best-effort cleanup are the
  module's, so the two procedures cannot drift. The display and original
  variants share one uuid with an `.orig` infix, and `objectKeyFromMediaPath`
  returns `null` for provider URLs — cleanup never touches them. Without the
  row lock, two racing replacements could both read the same old keys and
  each delete them after its own swap, orphaning the pair the first to
  commit wrote. The lifecycle interface accepts the bare `Database` handle,
  not a transaction handle, so its swap commits before object cleanup begins.
- **`scripts/reconcile-media.ts` must list the bucket BEFORE reading the
  `user` rows, and it holds the shared post-media advisory transaction lock
  through list/read/delete. Post attachment writers acquire that same lock
  across storage upload and attachment-row commit, closing the
  upload-before-row window without a pending schema state. The reverse order
  still treats a profile upload landing between the two steps as an orphan
  (issue #52; pinned by `src/reconcile-media.test.ts`).
- **Link preview fetching lives in `src/link-card-http.ts` (the wire) and
  `src/link-card.ts` (the cache), and the SSRF guard is not optional
  (issue #260).** Every outbound fetch goes through `guardedLinkFetch`: the
  scheme must be http(s), only the scheme's own port is dialled (80/443 —
  a host's database or internal status port is not a card target), the
  hostname is resolved via the Context-threaded `linkTransport` and every
  address must be global unicast — including IPv4-mapped IPv6 in its hex
  spelling, which is the form the URL parser actually produces from
  `[::ffff:127.0.0.1]` — redirects are followed manually with each hop
  re-checked, and size, time and content-type caps bound the response.
  Bracketed IPv6 literals are unwrapped in the transport's lookup
  short-circuit; that unwrap is safe only while `::ffff:0:0/96` stays in the
  refused table. The guard is unit-pinned with a fake transport and
  integration-pinned against a real loopback listener. A URL resolves at most
  once per revalidation window into the `link_card` table — including the
  "no card" answer, which is cached as a negative row so a dead URL is not
  refetched on every view. Every failure degrades to `{ card: null }`; a
  failing revalidation keeps serving the stale card. A lead image is fetched
  through the same guard, sniffed like an upload, stored under `link-cards/`
  inside the post-media lifecycle lock, and authorized by
  `canViewLinkCardMedia` (any signed-in viewer — the session the `/media`
  route already demands). Every card field, `domain` included, is capped at
  its `LINK_CARD_*_MAX_LENGTH`.
- **A link card's moderation lever is `moderation.purgeLinkCard`, and its
  audit trail is the row, not `moderation_action`.** A card is shared by
  every post carrying the URL, so purging is the one action that removes a
  hostile preview viewer-wide. The row is stamped `purgedAt`/`purgedBy`/
  `purgedReason` rather than deleted (a deletion would be refetched and the
  card would return) and `resolveLinkCard` refuses a purged URL before any
  freshness check, so no revalidation window re-opens it; the upsert carries
  `setWhere: purgedAt is null` so a revalidation in flight when the purge
  committed cannot write card fields back onto the row. The purge does not
  log a `moderation_action` row: that table's target columns are post- and
  user-shaped by schema, and stretching them to hold a URL would ripple
  through the queue, the audit view and their tests. The who/why/when lives
  on the row instead, guarded `FOR UPDATE` inside one transaction like every
  other moderation effect.
- **Every moderation effect reads its guard `FOR UPDATE`, inside its own
  transaction** (`removePostEffect`, `suspendUserEffect`, `banUserEffect`,
  `setRoleEffect`, `restorePostEffect`, `unbanEffect`, `restoreRoleEffect`).
  The audit log is append-only, so a double log is a lie about what happened;
  an unlocked pre-read is a TOCTOU two concurrent restores both pass (issue
  #51). The role overturn checks the contested grant under that same lock, so
  a racing role change can never be clobbered by an appeal that already passed
  its currency check. The effects return the notices they owe (`PendingEmail`)
  instead of sending them. The module's single entry point
  (`applyModerationEffect`, and the per-action wrappers `removePost`,
  `restorePost`, `suspendUser`, `banUser`, `unbanUser`, `setRole`) opens the
  transaction itself, runs the effect inside it, and sends the owed notices
  only after it commits — so a rollback produces no audit row, no partial
  state and no email, and the send can never be forgotten by a caller that
  goes through the wrappers. The raw effects remain exported for the appeal
  intake and the tests, which compose them directly; a new procedure must go
  through the wrappers, not call an effect and hand-thread the send.
- **Forward sanctions supersede older appeals in their control family.** The
  `removePost`, `suspendUser` and `banUser` wrappers lock the prior action rows
  and stamp their open appeals `superseded` in the same transaction as the new
  action. Suspension and ban are one account-sanction family; role changes
  remain a separate family. Review checks both live state and action ordering
  for either outcome, and the queue/case response carries every independently
  open appeal rather than one appeal slot per target.
- **A manual inverse action closes appeals under a shared action lock.** The
  `restorePost`, `unbanUser` and `setRole` wrappers lock the contested action
  rows, then stamp linked open appeals `reversed`, then lock/change the target,
  all in one transaction. Intake takes the same action lock through its insert,
  so reversal cannot miss an appeal being created. The wrappers do not fill
  review fields or log `appeal_resolved`; the inverse action's audit row and
  notice are the source of truth. The remaining appeal-before-target order
  matches `appealReview`, avoiding a review/reversal deadlock.
- **Cursors are bounded before they are decoded.** Every cursor input schema
  caps the encoded value at `CURSOR_MAX_ENCODED_LENGTH`, and the shared codec
  repeats that check before base64 decoding or JSON parsing. Decoded textual
  ids have their own bound, and all SQL cursor values still go through
  `sql.param(value, column)` — interpolating a JS `Date` hands postgres.js
  something it cannot serialise.
- **`keysetPage`'s `createdAtField` is type-tied to the `createdAt` column**, so
  a cursor can never encode a different timestamp than the SQL compares. Two
  lists bypass the skeleton on purpose: `moderation.queue` merges two shapes
  in JS, which does not fit a single query; and the home feeds'
  `feedEventPage` (`src/posts.ts`) unions authored-post and repost events
  whose cursor key is a three-part row value — `(event_at, post_id,
reposter_key)` — so it hand-rolls the same three parts the skeleton owns
  (row-value cursor filter, +1 lookahead, next-cursor anchored on the last
  returned row) rather than fit a pair-shaped helper.
- **Presigned URLs are windowed** (`MEDIA_SIGNING_WINDOW_MS`): byte-identical
  within a window, which is what keeps repeat views off the bucket. Every
  `/media/` redirect is `private, no-store` — a viewer-authorized decision —
  except profile display objects, whose redirect is the one stored class:
  `private`, and bounded by `secondsUntilWindowEnd()` so it can never outlive
  the signature it points at (`profileDisplayRedirectCacheControl`).
- **Signed appeal tokens have a 4 KiB input ceiling and a canonical signature.**
  Reject oversized or malformed base64url input before decoding or hashing so
  the one anonymous procedure cannot turn attacker-controlled strings into
  unbounded work.
- **Bulk deletion trusts only provider-confirmed `Deleted` entries.** An HTTP
  success may still include per-key S3 failures or omit an acknowledgement;
  preserve the confirmed count and throw `StorageDeleteError` for every
  requested key not confirmed as deleted.
- **PostgreSQL owns suspension expiry time.** `suspendUser` returns the
  `banExpires` value from the update and uses that exact timestamp in both the
  response and notification; do not calculate a second application-clock
  value.
- **Fixed-window, in-memory limits** reset on deploy and multiply per replica —
  right for bounding one client, wrong for billing. `maxKeys` is a leak alarm,
  not an admission gate: at capacity a brand-new key is let through, never
  refused (issue #60).
- **`src/constants.ts`, `src/dimensions.ts`, `src/post-image.ts` and
  `src/roles.ts` must stay dependency-free.** The browser imports them; an
  `@my-tuums/db` import throws at module load.
- **Account rules are not this package's to state.** The handle bounds, the bio
  limit, the date-of-birth rules and the preference lists live in
  `packages/auth/src/rules.ts` (`@my-tuums/auth/rules`), because `packages/auth`
  is where they are enforced. `usernameInput` in `src/users.ts` reads the bounds
  from there rather than repeating `3`/`20`, and `src/constants.ts` deliberately
  no longer carries a `BIO_MAX_LENGTH` copy — that copy existed only because
  the browser had no other dependency-free module to read, and it needed a
  drift test to stay honest. Re-adding one here re-creates the drift.
- **`src/moderation-inputs.ts` is a leaf on purpose.** The moderation router
  files must never import each other — a cycle fails at module evaluation.

## Dependencies and boundaries

- `Context.session` comes from `@my-tuums/auth`; `db` and the schema from
  `@my-tuums/db`. `apps/server` mounts `appRouter` at `/rpc` and serves
  `/media` through `createMediaResolver`.
- `src/media.ts` is a pure key-to-URL function with no session logic of its
  own — the server requires a live session before it is ever called.

## Verification

| Command                                                                       | Covers                                                           |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `pnpm --filter @my-tuums/api test:unit`                                       | pure logic; must pass with no database                           |
| `pnpm --filter @my-tuums/api test:integration`                                | real Postgres (`pnpm docker:up` first)                           |
| `pnpm --filter @my-tuums/api lint` / `typecheck`                              | this package alone                                               |
| `pnpm --filter @my-tuums/api reconcile:media`                                 | reap objects no row points at                                    |
| `pnpm --filter @my-tuums/api prune:notifications --apply --retention-days=90` | delete notifications past the shared horizon (moderation exempt) |

Suites split by filename: `*.test.ts` is unit (no I/O), `*.int.test.ts` is
integration. `fileParallelism: false` is deliberate — the harness in
`src/testing/harness.ts` shares one pool and one truncate. The unit project
blanks `DATABASE_URL`, so a unit test that reaches for the database fails by
name rather than quietly connecting to whatever the shell pointed at.

**Fixtures.** `createTestUser` mints an account and a real session through
`@my-tuums/auth/testing` — about 95ms, no password. `createPasswordTestUser`
goes through production sign-up and sign-in and costs about 430ms, two scrypt
hashes; reach for it **only** when a password being accepted or refused is the
assertion, or a suspension test will pass for the wrong reason (sign-in throws
because there is no credential, not because the account is banned). There are
currently two such tests, both in `src/moderation.int.test.ts`. Sign-up itself
is under test in `src/auth.int.test.ts`, which uses the production instance
throughout on purpose.

## Further reading

- [docs/architecture.md](../../docs/architecture.md) — context, media and moderation flows.
- [docs/security.md](../../docs/security.md) — the anonymous surface, rate-limit keys, privacy projection.
- [docs/product.md](../../docs/product.md) — the vocabulary these procedures implement.
