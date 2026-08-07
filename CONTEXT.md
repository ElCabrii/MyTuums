# MyTuums

A Twitter-style social app (posts, likes, follows, profiles). This glossary records
the shared language of the moderation system — roles, reports, blocks, and the
actions moderators take.

The system is built and shipped, so these definitions are normative rather than
aspirational: the code cites them (see `packages/api/src/moderation.ts` and the
page gate in `apps/server/src/request-handler.ts`). Change a definition here only
alongside the behaviour it describes.

## Language

**Role**:
A permission tier held by a user account, set by someone above them in the
hierarchy. Every account has exactly one role: `user` by default.
_Avoid_: Rank, clearance

**Moderator**:
A user with the `moderator` role — works the moderation queue: resolves
reports, removes posts, applies timed suspensions. Cannot appoint or demote
anyone, and cannot apply a permanent ban.
_Avoid_: Mod, helper

**Staff**:
A user with the `staff` role — senior moderators. Everything a moderator can
do, plus managing moderators (appoint/demote) and applying permanent bans.
_Avoid_: Admin, supermod

**Admin**:
A user with the `admin` role — the owner. Everything staff can do, plus
managing staff. The `admin` role is the top of the hierarchy.
_Avoid_: Owner, superuser

**Audit log**:
The append-only record of every moderation action — who did what to whom,
when, and why. Readable by staff and admin only; it is the evidence trail
behind appeals and the review of a moderator's work.
_Avoid_: Action history, moderation log

**Report**:
A complaint by one user about a post or another user, tagged with exactly one
report reason. Requires a session, and one report per (reporter, target) pair
— the same person cannot report the same thing twice; a repeat report with a
different reason refreshes the row's timestamp without creating a new one. A
report is marked handled (resolved, with an outcome) when a moderator deals
with it; the moderation queue is the unresolved reports grouped by target,
and a new report on an already-resolved target reopens the case by itself.
_Avoid_: Flag, ticket, complaint

**Removed post**:
A post whose content is hidden by a moderation action while the row itself
remains. It renders as a stub, its replies stay visible, and un-removing
restores it. Moderation removal is never a hard delete.
_Avoid_: Deleted post, purged post

**Moderation action**:
Any action by a moderator, staff member, or admin that the audit log records
— removing a post, suspending, banning, or appointing a role. Every
moderation action emails the affected user with the reason the moderator
wrote, including when an action is undone.
_Avoid_: Admin action, staff action

**Block**:
A user's action that severs their relationship with another user in both
directions: neither can see the other's posts, replies, or profile; existing
follows are deleted in both directions; and the blocked user can no longer
follow, reply to, or report the blocker. Silent — no notification. Not a
moderation action; user blocks are private.
_Avoid_: Mute (a different feature), shadowban

**Suspension**:
A moderation action that bars a user from signing in (sessions revoked) and
hides their content app-wide while active. Timed suspensions expire and
restore the content automatically.
_Avoid_: Lockout, shadowban

**Appeal**:
A request by the affected user to reconsider a moderation action. Opened from
the notification email or the removed-post stub, and lands in the moderation
queue as a labelled appeal, reviewed by any moderator except the one who took
the original action. Overturning an appeal undoes the action — which, like
any action, emails the user.
_Avoid_: Dispute, complaint

**Ban**:
A permanent suspension. Content stays hidden until the ban is lifted.
_Avoid_: Lifetime suspension, permaban
