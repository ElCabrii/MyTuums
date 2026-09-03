import { QueryClient } from "@tanstack/react-query";
import {
  type AuditEntry,
  type ModerationCase,
  type ModerationCaseDetail,
  type NotificationItem,
  type Post,
  type Profile,
  type TeamMember,
  type Thread,
  type UserSummary,
} from "@/lib/orpc";

/**
 * Domain fixtures and QueryClient tuning, with no side effects. Importing this
 * module installs nothing and reaches no network — it is safe from pure tests
 * (e.g. `src/lib/follow-cache.test.ts`) that must not drag the auth-client
 * install in. The auth fake and the session fixtures live in
 * `./auth-fixture.ts`; the router stand-in lives in `./route-tree.tsx`.
 */

/**
 * `retry: false` so an error state seeded by `queryFixtures` below
 * surfaces immediately instead of a test waiting out retry backoff.
 * `refetchOnMount: false` so a query that already has data seeded via
 * `queryClient.setQueryData` stays exactly as seeded when a component mounts
 * and observes it, instead of firing a real (network-dependent,
 * unmockable-without-a-lot-of-effort) background refetch the instant it
 * renders.
 *
 * `retryOnMount: false` is the one that actually matters for a SEEDED ERROR
 * specifically, and is easy to miss: `refetchOnMount` only governs refetching
 * a query that has previously *succeeded* (`dataUpdatedAt > 0`). A query
 * that has only ever errored has `dataUpdatedAt === 0`, and TanStack Query's
 * own mount-fetch decision treats that case as "never actually got data yet"
 * — it fetches on mount REGARDLESS of `refetchOnMount`, unless
 * `retryOnMount` says not to. Without this, `PostFeed`'s/`UserList`'s
 * observer mounting against a query the fixture already drove to
 * "error" immediately fires one more real (and here, doomed) network fetch,
 * landing back on "error" but with a generic "fetch failed" message instead
 * of the one that was seeded — confirmed by instrumenting the actual `Query`
 * instance: neither `.reset()` nor `.setState()` fired, only `.fetch()`.
 */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        retryOnMount: false,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      },
      mutations: {
        retry: false,
      },
    },
  });
}

/** A minimal post author for fixtures. */
export function makeAuthor(overrides: Partial<Post["author"]> = {}): Post["author"] {
  return {
    id: crypto.randomUUID(),
    name: "Alex Mercer",
    username: "alexmercer",
    displayUsername: "AlexMercer",
    image: null,
    ...overrides,
  };
}

/** A minimal post for fixtures. */
export function makePost(overrides: Partial<Post> = {}): Post {
  return {
    id: crypto.randomUUID(),
    content: "Hello, world!",
    createdAt: new Date(),
    parentId: null,
    author: makeAuthor(),
    likeCount: 0,
    replyCount: 0,
    viewerHasLiked: false,
    // The quote reference (issue #261): not a quote by default — the embedded
    // card branches in post-card own their own fixtures.
    quotedPostId: null,
    repostCount: 0,
    viewerHasReposted: false,
    // Attribution is a feed-event property; a plain post row carries none.
    repostedBy: null,
    viewerHasBookmarked: false,
    // The tombstone fields (issue #38, plus the author's own delete in #148):
    // never removed or deleted by default — the two stub branches in
    // post-card own their own fixtures. Same for the edit marker (#264):
    // never edited unless a test says so.
    removed: false,
    deleted: false,
    removedReason: null,
    editedAt: null,
    unavailable: false,
    ...overrides,
    parent: overrides.parent ?? null,
    quoted: overrides.quoted ?? null,
    attachments: overrides.attachments ?? [],
  };
}

/** A minimal follower/following list entry for fixtures. */
export function makeUserSummary(overrides: Partial<UserSummary> = {}): UserSummary {
  return {
    id: crypto.randomUUID(),
    name: "Jamie Rivera",
    username: "jamierivera",
    displayUsername: "JamieRivera",
    image: null,
    bio: null,
    bannerImage: null,
    createdAt: new Date(),
    followedAt: new Date(),
    viewerIsFollowing: false,
    ...overrides,
  };
}

/** A complete public profile fixture, including counts and suspension state. */
export function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: crypto.randomUUID(),
    name: "Alex Mercer",
    username: "alexmercer",
    displayUsername: "AlexMercer",
    image: null,
    bio: null,
    bannerImage: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    followerCount: 0,
    followingCount: 0,
    viewerIsFollowing: false,
    suspended: false,
    badges: [],
    ...overrides,
  };
}

/** A focused thread fixture with no ancestors and no truncation by default. */
export function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    post: makePost(),
    ancestors: [],
    truncated: false,
    ...overrides,
  };
}

/**
 * A minimal moderation queue row — mirrors the merged-case shape
 * `moderation.queue` returns (`packages/api/src/moderation-queue.ts`'s
 * `MergedCase`). No open reports and no appeal by default; a real case
 * always has at least one of the two.
 *
 * `preview` defaults to `null` — the target-row-is-gone case — so a test that
 * says nothing about the target gets the fallback rendering rather than a
 * fixture identity it never asked for. `makeCasePreview` builds the other two.
 */
export function makeModerationCase(overrides: Partial<ModerationCase> = {}): ModerationCase {
  return {
    targetType: "post",
    targetId: crypto.randomUUID(),
    newestAt: new Date(),
    reportCount: 1,
    reasons: ["spam"],
    appeals: [],
    preview: null,
    ...overrides,
  };
}

/** The person half of a queue preview: a post's author, or the reported account. */
type PreviewPerson = Extract<NonNullable<ModerationCase["preview"]>, { kind: "user" }>["user"];

function makePreviewPerson(overrides: Partial<PreviewPerson> = {}): PreviewPerson {
  return {
    id: "user-1",
    name: "Alex Mercer",
    username: "alexmercer",
    displayUsername: "AlexMercer",
    image: null,
    ...overrides,
  };
}

/** A post-target queue preview: the author plus the server-bounded excerpt. */
export function makePostPreview(
  overrides: Partial<Extract<NonNullable<ModerationCase["preview"]>, { kind: "post" }>> = {},
): ModerationCase["preview"] {
  return {
    kind: "post",
    excerpt: "the reported post",
    truncated: false,
    isReply: false,
    removed: false,
    attachments: [],
    author: makePreviewPerson(),
    ...overrides,
  };
}

/** A user-target queue preview: the account plus its effective ban state. */
export function makeUserPreview(
  overrides: Partial<Extract<NonNullable<ModerationCase["preview"]>, { kind: "user" }>> = {},
): ModerationCase["preview"] {
  return {
    kind: "user",
    user: makePreviewPerson(),
    banned: false,
    banExpires: null,
    ...overrides,
  };
}

/**
 * A minimal moderation case detail for the post branch — the shape
 * `moderation.case` returns for a post target (raw content, tombstone
 * fields, the moderator's author projection).
 */
export function makeModerationCaseDetail(
  overrides: Partial<Extract<ModerationCaseDetail["target"], { kind: "post" }>> = {},
  common: Partial<Omit<ModerationCaseDetail, "target">> = {},
): ModerationCaseDetail {
  return {
    targetType: "post",
    targetId: crypto.randomUUID(),
    reports: [],
    // A plain empty list: `moderation.case` returns every open appeal against
    // the target, so the field is an array whose emptiness is the "no open
    // appeal" case. (It used to be a single appeal typed as always-present,
    // which needed a cast here to stay truthful about the wire's null.)
    appeals: [],
    ...common,
    target: {
      kind: "post",
      id: crypto.randomUUID(),
      content: "Hello, world!",
      createdAt: new Date(),
      parentId: null,
      // Not a quote by default; the case dialog's quoted section owns its own
      // fixture when a test exercises it.
      quotedPostId: null,
      quoted: null,
      removedAt: null,
      removedBy: null,
      removedReason: null,
      // Same convention as makePost's `editedAt`: never edited by default, so
      // a test that wants history says so.
      editedAt: null,
      editHistory: [],
      editHistoryTruncated: false,
      attachments: [],
      author: makeAuthor(),
      ...overrides,
    },
  };
}

/**
 * A minimal moderation case detail for the user branch — the shape
 * `moderation.case` returns for a user target (role and ban state, no raw
 * content). A distinct factory from {@link makeModerationCaseDetail} rather
 * than a union parameter: the two branches share almost no fields, and a
 * caller always knows which one it's building.
 */
export function makeUserModerationCaseDetail(
  overrides: Partial<Extract<ModerationCaseDetail["target"], { kind: "user" }>> = {},
  common: Partial<Omit<ModerationCaseDetail, "target">> = {},
): ModerationCaseDetail {
  return {
    targetType: "user",
    targetId: crypto.randomUUID(),
    reports: [],
    appeals: [],
    ...common,
    target: {
      kind: "user",
      id: crypto.randomUUID(),
      name: "Jamie Rivera",
      username: "jamierivera",
      displayUsername: "JamieRivera",
      image: null,
      bio: null,
      bannerImage: null,
      createdAt: new Date(),
      role: "user",
      banned: false,
      banExpires: null,
      banReason: null,
      ...overrides,
    },
  };
}

/**
 * A minimal moderation report row — `moderation.case`'s `reports` shape.
 * Unresolved (`resolvedAt: null`) by default so the Actions card renders;
 * a test pinning a resolved state overrides the resolution fields.
 */
export function makeModerationReport(
  overrides: Partial<ModerationCaseDetail["reports"][number]> = {},
): ModerationCaseDetail["reports"][number] {
  return {
    reporterId: crypto.randomUUID(),
    reason: "spam",
    // No snapshot by default: a report needs one only when the test is about
    // the wording it was raised against (issue #264).
    snapshotContent: null,
    createdAt: new Date(),
    resolvedAt: null,
    resolvedBy: null,
    resolvedOutcome: null,
    resolutionNote: null,
    ...overrides,
  };
}

/** A minimal audit-log entry — `moderation.auditLog`'s row shape, no actor/target by default. */
export function makeAuditEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: crypto.randomUUID(),
    action: "post_removed",
    actorId: null,
    targetType: "post",
    targetPostId: crypto.randomUUID(),
    targetUserId: null,
    reason: null,
    note: null,
    // `moderation_action.details` is `jsonb().notNull().default({})` — never
    // null, unlike every other optional column here.
    details: {},
    createdAt: new Date(),
    actor: null,
    targetUser: null,
    ...overrides,
  };
}

/** A minimal moderation-team roster entry — `moderation.team`'s row shape. */
export function makeTeamMember(overrides: Partial<TeamMember> = {}): TeamMember {
  return {
    id: crypto.randomUUID(),
    name: "Jamie Rivera",
    username: "jamierivera",
    displayUsername: "JamieRivera",
    image: null,
    role: "moderator",
    ...overrides,
  };
}

/** A minimal notification row — `notification.list`'s shape, a like by default. */
export function makeNotification(overrides: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id: crypto.randomUUID(),
    type: "like",
    read: false,
    createdAt: new Date(),
    postId: crypto.randomUUID(),
    // No post preview by default (issue #281): a row asserting the preview
    // sets these itself, and every other fixture stays a bare sentence.
    postContent: null,
    postAttachments: [],
    actor: makeAuthor(),
    action: null,
    targetPostDeletedAt: null,
    ...overrides,
  };
}
