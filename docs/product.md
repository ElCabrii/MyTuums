# Product

What MyTuums actually does today, and the words the code uses for it. Every
statement here describes shipped behaviour; where a feature depends on
configuration, that is marked **Configuration-dependent**. For the mechanics
behind any of it, see [architecture.md](architecture.md).

MyTuums is a Twitter-style social app: short posts, replies, likes, a follow
graph, profiles, search, and a moderation system with appeals. **The site is
private with one public surface** — everything except the auth/legal pages and
the `/post/<id>` permalinks requires a session, enforced both by the server's
page gate and by the client. A signed-out visitor on a permalink reads the
thread (post, ancestors, replies) with interaction controls replaced by a
sign-in link; post-level privacy beyond the existing visibility rules is a
0.5.0 concern.

## Accounts and authentication

- Email and password sign-up, with a lowercase handle (username), a date of
  birth, and an explicit acceptance of the Terms of Service and Privacy Policy.
  Accounts must be at least 15 years old; the rule is enforced identically on
  the client and in a database hook. Consent is recorded on the account as a
  timestamp plus the accepted legal version; accounts created before this
  recording existed remain without a recorded acceptance. Signed-in accounts
  that have never recorded legal consent, or whose recorded legal version is
  stale, are held on any page by a global consent dialog until they accept the
  current Terms of Service and Privacy Policy — and the API refuses them
  independently of the dialog, so the hold is not something a browser can be
  talked out of.
- **Two-factor** authentication (TOTP, plus email codes) and **passkeys**
  (WebAuthn).
- **OAuth sign-in with Google, Discord and Twitch.** _Configuration-dependent_:
  a provider appears only when both halves of its credential pair are set
  server-side **and** it is listed in `VITE_SOCIAL_PROVIDERS` at build time.
- **Google One Tap.** _Configuration-dependent_ on `VITE_GOOGLE_CLIENT_ID`;
  it is offered only to visitors who have had a session before.
- OAuth sign-ups arrive without a handle or date of birth, so `/welcome`
  claims both before the account can be used, then offers two-factor once.
- Email verification and password reset. _Configuration-dependent_ on
  `RESEND_API_KEY`: without it, messages are logged to the server console in
  development and throw in production rather than being silently dropped.
  TOTP two-factor, sign-up and sign-in work fully without it.
- Sessions are revoked on password reset, and a revoked session stops
  authenticating immediately — there is no session cookie cache.

## Posts, replies, likes, follows

- Posts are plain text, up to 500 characters, trimmed. A post or reply carries
  text, up to four images, or both — a submission with neither is refused, and
  an image-only post stores an empty body rather than placeholder whitespace.
  Rendering recognizes
  three link shapes in that text and nothing else. Syntactically valid `@handles`
  become links to lowercase canonical profile routes; malformed handles stay as
  plain text, and an unknown handle lands on the profile route's existing
  not-found state. Absolute `http` and `https` URLs become external links that
  open in a new tab, keeping the address as it was typed and leaving the
  sentence punctuation around it outside the link. Every other scheme —
  `javascript:`, `data:`, `ftp:` — stays inert text. A `#tag` — a hash followed by one or
  more ASCII letters, digits or underscores — becomes a link to post search
  filtered to that tag, canonicalized to lowercase exactly like a handle.
  One character is a complete tag: unlike a handle, there is no minimum
  length. The query keeps the `#` so it matches hash-marked occurrences
  rather than the bare word — but post search is a case-insensitive
  substring scan, so a longer tag (`#tag_expo`), a glued word (`word#tag`)
  or a URL fragment (`https://example.com/#tag`) matches it all the same.
  Accented letters are not tag characters
  even though the app is bilingual, so `#café` and `#été` stay plain text —
  as does any hash that is not followed by a complete tag (a lone `#`,
  `##tag`, `word#tag`, `#tag-way`), exactly like a malformed handle. A tag
  link is nothing more than an entry into chronological post search: there is
  no trending, no tag ranking, no suggested tags and no tag follow.
- The first URL in a post or reply may render a link preview card beneath the
  text: domain, title, description and — when the target provides one — a lead
  image (issue #260). The second and later URLs stay plain links. Fetching is
  server-side only, against the same http(s) rule the linkifier applies, with
  private/loopback/link-local addresses refused, redirects re-checked at every
  hop, only the scheme's own port dialled, and size and time caps on the
  fetch. A URL is fetched at most once per revalidation window and cached by
  URL, so every post carrying it shares one card; a URL with no Open Graph
  payload is cached as "no card" the same way. The post's stored text is never
  modified. A fetched lead image is stored in the media bucket and served
  from `/media/` like any other object, never hot-linked from the target.
  Every failure mode — a dead or refused target, a timeout, a missing payload
  — leaves the post with the plain link it always had. A moderator can purge
  a URL's card (`moderation.purgeLinkCard`), which removes the preview from
  every post carrying the URL and stops the URL from ever unfurling again.
- A reply is a post with a parent. Threads show the focused post, up to 20
  ancestors of context, and keyset-paginated direct replies. Beneath each
  direct reply, the thread groups the deterministic descendant branch first
  joined by the focused post's author: the path to that author's earliest
  reply is shown, then the oldest child at each later fork. Unrelated branches
  remain collapsed. Long grouped branches start with a bounded slice and
  expand in place through **Show more replies**.
- An author can delete their own post. Deletion is a tombstone, not a row
  delete: fresh feeds and profiles omit it, while its own URL and thread
  context render a stub saying its author deleted it. Its replies, its likes
  and the conversation above it are untouched. It is not a
  moderation action — no audit row, no email, nothing to appeal — and a post a
  moderator already removed cannot be deleted on top, so the author keeps the
  stated reason and the appeal link. Deleted posts are not search results, for
  the same reason removed ones aren't.
- An author can edit the text of their own post or reply. The same
  500-character trim rule as creation applies, and images are not editable —
  an edit rewrites the body and nothing else. An edited post carries a visible
  "Edited" marker with the last edit time wherever it renders. Editing never
  changes the post's timestamp, so feeds and search reflect the new text
  without re-ranking or bumping the post. A removed or deleted post cannot be
  edited — a removal keeps the story the author would appeal about immutable.
  A post under review stays editable: every edit records the text it replaced,
  and the moderation case view shows that history (the 50 most recent
  versions) beside the current text, so a moderator judges everything the
  author wrote rather than only what currently stands. A report also
  snapshots the post's text at the moment it was filed, and the case view
  quotes that snapshot on the report — so a rewrite cannot hide the wording a
  report was raised against, and the moderator sees exactly what the
  reporter saw without reconstructing it from timestamps. The same holds when
  the judged post is a quote: the case view shows the quoted original's edit
  history beside its current text too, so the original's author rewriting it
  after being quoted cannot hide the wording the quote amplified (the report
  snapshots cover the quoting post's text, not the original's). Editing is
  idempotent: re-sending the same text is a no-op that does not restamp the
  marker.
- Likes are two idempotent operations, `like` and `unlike`, never a toggle —
  so a retry is safe and ordering cannot invert the result. Like and reply
  counts are derived on read, not denormalised.
- Reposts (re-sharing an existing post, no added text) are the same shape:
  `repost` / `unrepost`, idempotent, with the repost count derived on read. A
  repost is an event, not a post: it has no text or images of its own, and the
  home feeds render the original post attributed to the reposter at the
  repost's timestamp. Reposting your own post is allowed; "reposting a repost"
  has no target — every repost action names an original post. A profile feed
  carries the author's own reposts interleaved with their posts at the
  repost's timestamp (the profile's All and Posts tabs; the Replies tab does
  not, and neither does the original author's profile — a profile shows the
  events its owner caused, never other people's amplifications of the owner's
  posts). Only top-level posts are offered the repost control: no surface the
  app ships creates a repost of a reply, so the action would never render
  anywhere (the row remains legal — the API accepts it — it is the surfaces
  that have nowhere to put it). On a card, the control is one pill that opens
  a menu offering repost or quote; on a reply — where the repost arm is not
  offered — the quote action renders as its own button instead.
- A quote is a normal post — every text and image rule applies — plus a
  reference to the quoted post, which renders embedded inside it in every
  context: feed, permalink, thread, search results and the moderation case
  view. A reply cannot also be a quote. Quotes render one level deep: a quote
  may itself be quoted, but the embedded preview carries no quote reference of
  its own, so a quote-of-quote shows the middle post's words and drops the
  card embedded in them. Quoting a reply is allowed, and its embedded card
  shows the reply without the "Replying to…" line a reply in a feed carries —
  a known gap in the embedded preview, not a rule.
- Both degrade the same way when the original goes away, decided with the
  issue: an author-deleted original renders the deletion stub in place of the
  embedded post (a repost event stays in the feed, and the quote's own text
  survives); a moderator-removed original renders the removal stub; an
  original whose author is banned or blocked reads like the author is gone —
  a quote keeps its own words with an unavailable embedded post, while a repost
  keeps the reposter's event but redacts the original author, content, media,
  counts and interactions to the unavailable treatment.
- Bookmarks are the same idempotent pair — `bookmark` / `unbookmark` — holding
  a post for later. They are private by construction: no counts, no visibility
  to other users or to the post's author, nothing on the public profile, and
  no surface reads them but the saver's own bookmarks page. That page lists
  saved posts strictly by when they were saved, newest first, keyset-paginated;
  there are no notes, folders or orderings. Saving your own posts is allowed.
  A post deleted by its author drops off the page, a moderator-removed one
  stays as its stub, and unbookmarking a deleted post is not an error. Neither
  is unbookmarking a post whose author has since blocked the saver or been
  banned: the row is the saver's own, so a saved post can always be removed
  even once it no longer renders.
- Follows are the same shape: `follow` / `unfollow`, with follower and
  following lists.
- Feeds come in two scopes — everyone, and the people you follow — and are
  keyset-paginated so a page boundary can never skip or repeat an event. The
  timeline is strictly reverse-chronological by event time — a post at its own
  creation, a repost at the repost's — with no ranking and no deduplication:
  the same post can appear once authored and once reposted.

## Notifications

A like on your post, a reply to your post, a repost of your post, a quote of
your post, a new follower, and a moderation action on your content or account
each leave one in-app notification — written in the same transaction as the
event that caused it, and exactly once per event: a retried like, repost or
follow mints no second notice, while like → unlike → like again is honestly
three events, not one collapsed one.

- The notifications page (`/notifications`, reached from the header bell)
  lists them newest first, keyset-paginated like the feeds, with no grouping
  or ranking. The bell carries an unread count; opening the page is what
  marks everything read.
- A row about a post previews it (issue #281): the liked post's text — with
  thumbnails of its images — or the reply itself for a reply, as one
  truncated line under the sentence. A moderator-removed post previews
  nothing, the same tombstone rule every post surface follows; an
  author-deleted post takes its whole row away.
- A rapid burst of one kind of event from one person — like → unlike → like
  cycling — moves the badge at most once a minute: every event still appears
  on the page, still unread, but the badge counts the burst as one tick.
  Different kinds of event each tick — a like, a reply and a follow are three
  signals, not one — and moderation notices are never damped.
- Self-caused events never notify — liking, replying to, reposting or
  quoting your own post creates nothing.
- Blocks hold on both sides: a user blocked by the recipient cannot generate
  notifications for them (a block hides the author before the like, reply,
  repost or quote can happen), and a notification from someone later blocked
  stops surfacing, coming back if the block is lifted.
- Deleting a post tombstones the notifications about it — the reply that is
  gone from the feed takes its notice with it, the way the reply count
  already drops deleted replies — without deleting the rows.
- Moderation notifications appear in-app alongside the email the action
  already sends; the email flow is unchanged. They speak as MyTuums rather
  than naming the moderator who acted, and carry the action code and the
  moderator's stated reason. Case resolutions notify nobody in-app — their
  notices go to the reporters, and email stays that channel.
- A repost notification points at the reposted post; a quote notification at
  the quote itself — the thing the recipient will click through to is what
  the quoter said, not their own post back. An unrepost removes nothing:
  notification rows are historical, the same deal like notifications get.
- The release's other actions stay silent, and the silence is decided, not
  open. Edits never notify — an edit is not an event about the recipient.
  Bookmarks never notify — they are private by design, and no emission point
  exists. Link-card fetches and purges never notify — neither is an action
  on a person, and the purge audit trail lives on the link card itself, by
  design.

## Profiles and search

- A profile carries a display name, lowercase handle, bio (160 characters),
  avatar, banner, join date, and follower/following counts. Bios use the same
  safe linkification as posts and replies.
- Profiles are addressed by handle. A profile hidden by a block reads as "no
  such user"; a banned profile resolves to a suspended stub instead, without
  its authored profile fields or relationship counts.
- Search has three surfaces: a profile-only header typeahead (up to five
  users), a full user search, and a full post search. User results rank
  handle-prefix matches ahead of substring matches.

## Media

_Configuration-dependent_: uploads require the `S3_*` group. Without it the
app runs normally and the two upload procedures report `NOT_IMPLEMENTED`.

- Accepted types are WebP, PNG and JPEG everywhere, decided by sniffing the
  bytes — never by the declared content type — with per-slot size limits and
  a 50-megapixel ceiling.
- Avatars and banners are stored as a pair: the browser uploads a
  display-sized WebP variant plus the untouched original, sharing one
  identifier. The original keeps whatever metadata it arrived with, so a
  picture can be refitted or re-cropped later without lost pixels; only
  signed-in viewers authorized for the profile can read it either way.
- The banner crop editor centers a fixed outline around the actual 3:1 region
  that will be stored, with the wider source context visible around it.
  Dragging moves the image beneath that frame and scrolling zooms it; zoom-out
  stops when the selected region reaches the source's full width or height, so
  the stored banner never contains letterbox bars.
- A post or reply can carry up to four images. Each is re-encoded in the
  browser before upload and no original is kept: the stored image is bounded
  in dimensions and bytes, and carries no camera/GPS (EXIF) metadata (issue
  #207). Clicking an attachment opens it in an in-app full-size viewer — the
  same accessible dialog profile pictures use — rather than navigating to its
  storage URL.
- Replacing or removing a profile image is atomic: the new objects are
  written first, the profile's references swap in one locked database step,
  and only then is the superseded pair deleted. A failed upload or removal
  never leaves a profile pointing at missing media.
- Images are stored as relative `/media/<key>` paths and served as a redirect
  to a short-lived presigned URL. Viewing one requires a session.
- A link preview's lead image lives under `link-cards/<uuid>.<ext>` and is
  public to every signed-in viewer: it is web content this app mirrored into
  its own bucket, owned by no user, and validated from its bytes before
  storage exactly like an upload.

## Locale and theme

- English and French, compiled from `apps/web/messages` by Paraglide. The
  locale lives in a cookie that governs both client copy and server-side auth
  error messages, so one choice covers the whole app.
- Light and dark themes, persisted locally and applied before first paint.
- Legal pages (`/privacy`, `/terms`, `/mentions-legales`) are localized like
  everything else; the French text of `/mentions-legales` is the legally
  authoritative filing.

## Blocks

A block is a user's own tool, not a moderation action, and it is private —
the blocked person is never told.

Blocking is mutual in effect: neither party sees the other's posts, replies or
profile; follows are deleted in both directions; and the blocked user can no
longer follow, reply to, or report the blocker. Reporting a _post_ across a
block is still allowed — the block hides the author from the viewer, not the
evidence from the moderators. Blocked users are managed from the account
settings page.

## Moderation

Four roles form a strict hierarchy: `user` → `moderator` → `staff` → `admin`.
A role can only be granted or revoked by someone strictly above it.

- **Reporting.** Any signed-in user can report a post or a user with one
  reason code. Post reasons: spam, harassment, hate speech, misinformation,
  self-harm, illegal content, NSFW. User reasons: spam, harassment,
  impersonation, underage. Self-reports are refused. A post report snapshots
  the post's text as it stood when filed, so the reported wording survives
  any later edit; a repeat report refreshes the snapshot along with the
  case's clock.
- **Queue.** Moderators see unresolved reports grouped by target, merged with
  every independently open appeal, newest first. Resolving a case marks it
  actioned or dismissed.
- **Moderator powers.** Remove and restore posts; suspend and unsuspend users
  for a fixed term between one hour and one year.
- **Staff powers.** Everything a moderator can do, plus permanent bans and
  unbans, granting and revoking roles, the team view and the audit log.
- **Notification.** Every moderation action on a user's content or account
  emails the affected user with the reason the moderator wrote — including
  when an action is undone — and leaves an in-app notification saying the
  same thing on their notifications page.
- **Nine recorded action codes:** `post_removed`, `post_restored`,
  `user_suspended`, `user_unsuspended`, `user_banned`, `user_unbanned`,
  `role_changed`, `case_resolved`, `appeal_resolved`.

## Appeals

Four actions are appealable — post removal, suspension, ban, and role change —
because each has a defined inverse.

An appeal is opened one of two ways: from the link in the notification email,
which works **signed out** (a banned user cannot sign in), or from a signed-in
author's removed-post stub. A signed-in appellant is shown the post being
appealed — its original text, its images and the stated reason — above the
form; signed out, the form stands alone, because a removal notice describes a
post only its author may see. The removal email itself names the post the same
way: it quotes the text, counts the images, and for an image-only post says so
rather than quoting nothing. The appeal lands in the moderation queue labelled
as such, and is reviewed by any moderator **except the one who took the
original action**. Overturning an appeal applies the inverse action, which —
like any action — emails the user. An appeal's own text is between 10 and 2000
characters. If a moderator reverses the contested action directly, the appeal
closes as `reversed` and leaves the queue; the inverse action still emails the
affected user, but the appeal is not recorded as having been reviewed. If a
newer moderation action replaces the contested action, the appeal closes as
`superseded` without review fields; the newer action is the one that remains
available for appeal. A suspension and a permanent ban are one sanction family
for this purpose, while a role-change appeal remains independent. A post
appeal whose author then deletes the post closes as `withdrawn` — the author
is the appellant, so deleting the contested post ends the grievance; no review
fields are filled and nothing was undone.

## Glossary

These definitions are normative: the code cites them, so change a definition
only alongside the behaviour it describes.

**Role** — a permission tier held by an account, set by someone strictly above
it. Every account has exactly one; `user` by default. _Avoid:_ rank,
clearance.

**Moderator** — the `moderator` role. Works the queue: resolves reports,
removes and restores posts, applies timed suspensions, reviews appeals. Cannot
appoint or demote anyone and cannot ban permanently. _Avoid:_ mod, helper.

**Staff** — the `staff` role. Everything a moderator can do, plus permanent
bans, managing moderators, the team view and the audit log. _Avoid:_ admin,
supermod.

**Admin** — the `admin` role, the top of the hierarchy: everything staff can
do, plus managing staff. _Avoid:_ owner, superuser.

**Report** — a complaint about one post or one user, tagged with exactly one
reason. Requires a session. One row per (reporter, target): a repeat report
refreshes the timestamp and keeps the first reason, which reopens a resolved
case rather than creating a second one. _Avoid:_ flag, ticket, complaint.

**Block** — a user's private, silent severing of their relationship with
another user, in both directions. Not a moderation action. _Avoid:_ mute (a
different thing), shadowban.

**Removed post** — a post whose content is hidden by a moderation action while
the row remains. It renders as a stub, its replies stay visible, and restoring
it brings the content back. Removal is never a hard delete. _Avoid:_ deleted
post (that is the author's own act — see below), purged post.

**Deleted post** — a post whose author took it down themselves. Like a removal
it is a tombstone rather than a row delete, but fresh feeds and profiles omit
it; its own URL and thread context render the stub. It is not a moderation
action: nothing is audited, nobody is emailed, there is nothing to appeal, and
it cannot be restored. _Avoid:_ removed post, withdrawn post.

**Edited post** — a post whose author rewrote its text after publishing. The
row carries the last edit time and every surface renders an "Edited" marker;
the creation timestamp never moves, so an edit never re-ranks a feed. Each
edit records the text it replaced; that history is visible to moderators in
the case view, never on public surfaces. A removed or deleted post cannot be
edited. _Avoid:_ updated post, revised post.

**Repost** — a user re-sharing an existing post to their followers, with no
added text or images. An event about the original, not a post of its own: the
feed renders the original attributed to the reposter. Idempotent as a pair
(`repost` / `unrepost`). _Avoid:_ retweet, boost, share.

**Quote post** — a normal post that references another post, which renders
embedded inside it. Carries every post rule; a reply cannot also be a quote.
The embedded card renders one level deep: a quoted quote loses its own
embedded card. _Avoid:_ quote tweet, comment with quote.

**Moderation action** — any act by a moderator, staff member or admin that the
audit log records. Every one of them emails the affected user, including
undos. _Avoid:_ admin action, staff action.

**Suspension** — a moderation action that bars sign-in (sessions revoked) and
hides the user's content app-wide while active. Timed: between one hour and
one year, expiring on its own. _Avoid:_ lockout, shadowban.

**Ban** — a permanent suspension. Content stays hidden until it is lifted.
_Avoid:_ lifetime suspension, permaban.

**Audit log** — the append-only record of every moderation action: who did
what to whom, when, and why. Readable by staff and admin only. It is the
evidence behind appeals and the review of a moderator's work. _Avoid:_ action
history, moderation log.

**Appeal** — a request by the affected user to reconsider a moderation action.
Opened from the notification email or a removed-post stub, reviewed by any
moderator except the one who acted. _Avoid:_ dispute, complaint.

**Notification** — one in-app notice of something that happened to you: a like
on your post, a reply to it, a repost of it, a quote of it, a new follower,
or a moderation action on your content or account. Newest first on
`/notifications`, unread until the page is opened. One per event, never one
per retry. Likes, replies, reposts, quotes and follows older than ninety
days fall out of the page and the badge together; moderation notices are
kept. _Avoid:_ alert, ping, message (a different thing that does not exist
yet).

## Further reading

- [architecture.md](architecture.md) — how each of these is implemented.
- [security.md](security.md) — what is public, what is gated, and why.
