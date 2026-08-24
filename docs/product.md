# Product

What MyTuums actually does today, and the words the code uses for it. Every
statement here describes shipped behaviour; where a feature depends on
configuration, that is marked **Configuration-dependent**. For the mechanics
behind any of it, see [architecture.md](architecture.md).

MyTuums is a Twitter-style social app: short posts, replies, likes, a follow
graph, profiles, search, and a moderation system with appeals. **The site is
private** — every page except a small allowlist requires a session, enforced
both by the server's page gate and by the client.

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

- Posts are plain text, up to 500 characters, trimmed. Rendering recognizes
  two link shapes in that text and nothing else. Syntactically valid `@handles`
  become links to lowercase canonical profile routes; malformed handles stay as
  plain text, and an unknown handle lands on the profile route's existing
  not-found state. Absolute `http` and `https` URLs become external links that
  open in a new tab, keeping the address as it was typed and leaving the
  sentence punctuation around it outside the link. Every other scheme —
  `javascript:`, `data:`, `ftp:` — stays inert text, and a recognized URL never
  gets a preview, unfurl or link card.
- A reply is a post with a parent. Threads show the focused post, its replies,
  and up to 20 ancestors of context.
- An author can delete their own post. Deletion is a tombstone, not a row
  delete: the post reads as a stub saying its author deleted it, and its
  replies, its likes and the conversation above it are untouched. It is not a
  moderation action — no audit row, no email, nothing to appeal — and a post a
  moderator already removed cannot be deleted on top, so the author keeps the
  stated reason and the appeal link. Deleted posts are not search results, for
  the same reason removed ones aren't.
- Likes are two idempotent operations, `like` and `unlike`, never a toggle —
  so a retry is safe and ordering cannot invert the result. Like and reply
  counts are derived on read, not denormalised.
- Follows are the same shape: `follow` / `unfollow`, with follower and
  following lists.
- Feeds come in two scopes — everyone, and the people you follow — and are
  keyset-paginated so a page boundary can never skip or repeat a post.

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

- Avatars and banners only. Accepted types are WebP, PNG and JPEG, decided by
  sniffing the bytes — never by the declared content type — with per-slot size
  limits and a 50-megapixel ceiling.
- The browser uploads a display-sized WebP variant plus the untouched
  original; both are stored and share one identifier.
- Replacing or removing a profile image is atomic: the new objects are
  written first, the profile's references swap in one locked database step,
  and only then is the superseded pair deleted. A failed upload or removal
  never leaves a profile pointing at missing media.
- Images are stored as relative `/media/<key>` paths and served as a redirect
  to a short-lived presigned URL. Viewing one requires a session.

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
  impersonation, underage. Self-reports are refused.
- **Queue.** Moderators see unresolved reports grouped by target, merged with
  every independently open appeal, newest first. Resolving a case marks it
  actioned or dismissed.
- **Moderator powers.** Remove and restore posts; suspend and unsuspend users
  for a fixed term between one hour and one year.
- **Staff powers.** Everything a moderator can do, plus permanent bans and
  unbans, granting and revoking roles, the team view and the audit log.
- **Notification.** Every moderation action emails the affected user with the
  reason the moderator wrote — including when an action is undone.
- **Nine recorded action codes:** `post_removed`, `post_restored`,
  `user_suspended`, `user_unsuspended`, `user_banned`, `user_unbanned`,
  `role_changed`, `case_resolved`, `appeal_resolved`.

## Appeals

Four actions are appealable — post removal, suspension, ban, and role change —
because each has a defined inverse.

An appeal is opened one of two ways: from the link in the notification email,
which works **signed out** (a banned user cannot sign in), or from a signed-in
author's removed-post stub. The appeal lands in the moderation queue labelled
as such, and is reviewed by any moderator **except the one who took the
original action**. Overturning an appeal applies the inverse action, which —
like any action — emails the user. An appeal's own text is between 10 and 2000
characters. If a moderator reverses the contested action directly, the appeal
closes as `reversed` and leaves the queue; the inverse action still emails the
affected user, but the appeal is not recorded as having been reviewed. If a
newer moderation action replaces the contested action, the appeal closes as
`superseded` without review fields; the newer action is the one that remains
available for appeal. A suspension and a permanent ban are one sanction family
for this purpose, while a role-change appeal remains independent.

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
it is a tombstone rather than a row delete, and it renders as its own stub —
but it is not a moderation action: nothing is audited, nobody is emailed, there
is nothing to appeal, and it cannot be restored. _Avoid:_ removed post,
withdrawn post.

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

## Further reading

- [architecture.md](architecture.md) — how each of these is implemented.
- [security.md](security.md) — what is public, what is gated, and why.
