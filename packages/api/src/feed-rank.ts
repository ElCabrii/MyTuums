/**
 * The ranked-feed pipeline (issue #305): candidate sourcing, feature-based
 * scoring, snapshot persistence, and follow suggestions.
 *
 * One scorer serves the home **For you** (global), **Following**, and
 * **Discover** feeds; only the candidate set differs per scope. No ML — a
 * transparent weighted score (`scorePost`) over features the schema already
 * yields, with interest signals first, outside-network discovery second, and
 * raw popularity last.
 *
 * Deliberate boundaries:
 *
 * - This module never renders a post. It produces ordered IDs (+ repost
 *   attribution); `post.list` in `./posts.ts` hydrates each page through the
 *   shared `postSelection`, so tombstones, repost degradation, and visibility
 *   stay exactly one definition.
 * - It never imports `./posts.ts` or `./users.ts` — both import this module
 *   at the `post.list` call site, and a cycle would fail at evaluation.
 * - Scoring is pure JS over bounded SQL-sourced candidates, not a duplicated
 *   SQL formula: one `scorePost` to test, one place the weights live.
 */
import { ORPCError } from "@orpc/server";
import { isAllowedUsernameCharset } from "@my-tuums/auth/rules";
import { and, desc, eq, gt, gte, isNull, ne, not, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { Database } from "@my-tuums/db";
import {
  feedRankSnapshot,
  follow,
  followRequest,
  game,
  gameFavorite,
  post,
  postLike,
  postRepost,
  user,
  userBlock,
  type FeedRankSnapshotItem,
} from "@my-tuums/db/schema";
import {
  FEED_RANK_AUTHOR_PENALTY,
  RANK_SNAPSHOT_INVALID_MESSAGE,
  SEARCH_QUERY_MAX_LENGTH,
  FEED_RANK_CAP_AUTHOR_LIKES,
  FEED_RANK_CAP_AUTHOR_REPOSTS,
  FEED_RANK_CAP_FAVORITE_GAME,
  FEED_RANK_CAP_LIKE_TOPIC,
  FEED_RANK_CAP_POPULARITY,
  FEED_RANK_CAP_REPLY_TOPIC,
  FEED_RANK_CAP_REPOST_TOPIC,
  FEED_RANK_FRESHNESS_BUCKET_MS,
  FEED_RANK_FRESHNESS_HALF_LIFE_HOURS,
  FEED_RANK_HISTORY_LIMIT,
  FEED_RANK_MAX_SNAPSHOTS_PER_VIEWER,
  FEED_RANK_POOL_LIMIT,
  FEED_RANK_SNAPSHOT_TTL_MS,
  FEED_RANK_SPARSE_THRESHOLD,
  FEED_RANK_SUGGESTION_LIMIT,
  FEED_RANK_SUGGESTION_SCAN_LIMIT,
  FEED_RANK_THREAD_WALK_MAX_DEPTH,
  FEED_RANK_WEIGHT_FAVORITE_GAME,
  FEED_RANK_WEIGHT_FOLLOW,
  FEED_RANK_WEIGHT_FRESHNESS,
  FEED_RANK_WEIGHT_LIKE_AFFINITY,
  FEED_RANK_WEIGHT_POPULARITY_LIKE,
  FEED_RANK_WEIGHT_POPULARITY_REPLY,
  FEED_RANK_WEIGHT_POPULARITY_REPOST,
  FEED_RANK_WEIGHT_REPLY_TOPIC,
  FEED_RANK_WEIGHT_REPOST_AFFINITY,
  FEED_RANK_WINDOW_DAYS,
  FEED_RANK_WINDOW_MAX_DAYS,
} from "./constants.js";
import { textIn } from "./sql.js";
import { containsText } from "./search-text.js";
import { invisibleAuthor, privatePostHidden } from "./visibility.js";

/** The ranked scopes — the `feed` values a ranked `post.list` call may carry. */
export type RankScope = "global" | "following" | "discover";

/** Ranked reads only need selects; snapshot persistence accepts the full D1 store. */
type RankStore = Pick<Database, "select">;

/**
 * The features one candidate post is scored from. Counts are raw — capping
 * and weighting are `scorePost`'s half, so the pure function stays the one
 * place the weights live. Topic overlaps are generic hashtag tokens, not
 * catalog keys: only the favorite-game overlap resolves against the catalog.
 */
export interface RankFeatures {
  /** Catalog game-hashtag overlap with the viewer's favorite games. */
  favoriteGameOverlap: number;
  /** Generic tag overlap with the viewer's reply-thread topics. */
  replyTopicOverlap: number;
  /** The viewer's recent likes on this author's posts. */
  authorLikedPosts: number;
  /** Generic tag overlap with posts the viewer recently liked. */
  likedTopicOverlap: number;
  /** Whether the viewer follows the author (or is the author). */
  followsAuthor: boolean;
  /** The viewer's recent reposts of this author's posts. */
  authorRepostedPosts: number;
  /** Generic tag overlap with posts the viewer recently reposted. */
  repostedTopicOverlap: number;
  likeCount: number;
  repostCount: number;
  replyCount: number;
  /** Hours from the time-bucketed clock to the surfacing event. */
  eventAgeHours: number;
}

/**
 * The one scorer every ranked surface uses. Priority order, enforced by the
 * capped maxima: one favorite-game match (12) > the whole like category (7)
 * > the follow edge (5) > the repost category, the reply-topic interest, and
 * the popularity total (3 each). Author and topic affinity share one cap per
 * category, so matching both halves earns no more than saturating one. A
 * cold-start viewer (no history) scores on freshness, popularity, and the
 * diversity pass alone.
 */
export function scorePost(features: RankFeatures): number {
  const capped = (value: number, cap: number) => Math.min(Math.max(value, 0), cap) / cap;
  const likeAffinity =
    Math.min(
      capped(features.authorLikedPosts, FEED_RANK_CAP_AUTHOR_LIKES) +
        capped(features.likedTopicOverlap, FEED_RANK_CAP_LIKE_TOPIC),
      1,
    ) * FEED_RANK_WEIGHT_LIKE_AFFINITY;
  const repostAffinity =
    Math.min(
      capped(features.authorRepostedPosts, FEED_RANK_CAP_AUTHOR_REPOSTS) +
        capped(features.repostedTopicOverlap, FEED_RANK_CAP_REPOST_TOPIC),
      1,
    ) * FEED_RANK_WEIGHT_REPOST_AFFINITY;
  const popularity = Math.min(
    Math.log1p(Math.max(features.likeCount, 0)) * FEED_RANK_WEIGHT_POPULARITY_LIKE +
      Math.log1p(Math.max(features.repostCount, 0)) * FEED_RANK_WEIGHT_POPULARITY_REPOST +
      Math.log1p(Math.max(features.replyCount, 0)) * FEED_RANK_WEIGHT_POPULARITY_REPLY,
    FEED_RANK_CAP_POPULARITY,
  );
  const freshness =
    FEED_RANK_WEIGHT_FRESHNESS *
    Math.pow(0.5, Math.max(features.eventAgeHours, 0) / FEED_RANK_FRESHNESS_HALF_LIFE_HOURS);
  return (
    capped(features.favoriteGameOverlap, FEED_RANK_CAP_FAVORITE_GAME) *
      FEED_RANK_WEIGHT_FAVORITE_GAME +
    capped(features.replyTopicOverlap, FEED_RANK_CAP_REPLY_TOPIC) * FEED_RANK_WEIGHT_REPLY_TOPIC +
    likeAffinity +
    (features.followsAuthor ? FEED_RANK_WEIGHT_FOLLOW : 0) +
    repostAffinity +
    popularity +
    freshness
  );
}

/**
 * The recency clock, bucketed to the hour so scores never shift mid-scroll:
 * two builds inside one bucket score an identical pool identically, and the
 * frozen snapshot makes that stability hold across pages regardless.
 */
export function rankBucketedNow(now: Date = new Date()): Date {
  return new Date(
    Math.floor(now.getTime() / FEED_RANK_FRESHNESS_BUCKET_MS) * FEED_RANK_FRESHNESS_BUCKET_MS,
  );
}

/**
 * The repeated-author penalty, applied AFTER the pure score orders the pool:
 * each further post by an already-placed author keeps `1 / (1 + n * penalty)`
 * of its score, where n counts that author's posts already preceding it.
 * Mild, deterministic, and never a hard cap — no author is excluded, however
 * many posts they placed. The pure score above never knows about it.
 */
export function diversifyScores<T>(
  ordered: readonly T[],
  args: {
    authorOf: (item: T) => string;
    scoreOf: (item: T) => number;
    keyOf: (item: T) => string;
  },
): T[] {
  const seen = new Map<string, number>();
  return [...ordered]
    .map((item) => {
      const author = args.authorOf(item);
      const repeats = seen.get(author) ?? 0;
      seen.set(author, repeats + 1);
      return { item, penalized: args.scoreOf(item) / (1 + repeats * FEED_RANK_AUTHOR_PENALTY) };
    })
    .sort((a, b) => b.penalized - a.penalized || (args.keyOf(a.item) < args.keyOf(b.item) ? -1 : 1))
    .map((entry) => entry.item);
}

/**
 * The ranker's hashtag scan mirrors the client's linkifier
 * (`matchHashtag`/`matchUrl` in apps/web `linked-text.tsx`) so ranking never
 * trusts a token the renderer would not link: the tag charset is ASCII
 * `[a-zA-Z0-9_]` (`#foo_bar` is one valid tag), overlong tags are inert, and
 * the boundaries are Unicode-aware. A tag glued to a word (`a#doom`), after
 * a Unicode letter (`é#doom`), doubled (`##doom`), running into an accented
 * letter or hyphen (`#café`, `#doom-way` — wholly inert, never a prefix
 * match), or sitting inside an http(s) URL (`https://x/page#doom`, where the
 * URL match wins) yields nothing. No semantic text matching: a post without
 * the literal token carries no topic signal, however suggestive its words.
 */
const RANK_TAG_CHARACTER = /[a-zA-Z0-9_]/;
const RANK_UNICODE_WORD = /[\p{L}\p{M}\p{N}]/u;
/** Longest tag the scan recognizes — the client's hashtag ceiling. */
const RANK_TAG_MAX_LENGTH = SEARCH_QUERY_MAX_LENGTH - 1;

function isRankTagWordCharacter(character: string | undefined): boolean {
  return (
    character !== undefined &&
    (RANK_TAG_CHARACTER.test(character) || RANK_UNICODE_WORD.test(character))
  );
}

function isRankWordCharacter(character: string | undefined): boolean {
  return (
    character !== undefined &&
    (isAllowedUsernameCharset(character) || RANK_UNICODE_WORD.test(character))
  );
}

/** A span the URL match owns — hashtags inside one are fragments, not tags. */
interface UrlSpan {
  start: number;
  end: number;
}

/**
 * The http(s) spans a text's URL match would own, in code-point offsets.
 * Mirrors `matchUrl`'s start (a scheme not glued to a word) and extent (to
 * the next whitespace or delimiter) — enough that a `#fragment` inside one
 * never reads as a tag, exactly as the renderer treats it.
 */
function rankUrlSpans(characters: readonly string[]): UrlSpan[] {
  const spans: UrlSpan[] = [];
  const text = characters.join("");
  const scheme = /https?:\/\//gi;
  let match: RegExpExecArray | null;
  while ((match = scheme.exec(text)) !== null) {
    // RegExp offsets are UTF-16; the token scanner uses Unicode code points.
    const start = Array.from(text.slice(0, match.index)).length;
    if (isRankWordCharacter(characters[start - 1])) continue;
    let end = start + match[0].length;
    while (end < characters.length) {
      const character = characters[end];
      if (character === undefined || /[\s<>"\p{Cc}]/u.test(character)) break;
      end += 1;
    }
    spans.push({ start, end });
  }
  return spans;
}

function rankHashtagKeysIn(text: string, keys: Set<string>, maxKeys: number): void {
  // Code points, like the client's scan: a supplementary-plane letter is one
  // boundary character, never two surrogate halves.
  const characters = Array.from(text);
  const spans = rankUrlSpans(characters);
  let cursor = 0;
  while (cursor < characters.length) {
    if (characters[cursor] !== "#") {
      cursor += 1;
      continue;
    }
    if (spans.some((span) => cursor >= span.start && cursor < span.end)) {
      cursor += 1;
      continue;
    }
    const previous = characters[cursor - 1];
    if (previous === "#" || isRankTagWordCharacter(previous)) {
      cursor += 1;
      continue;
    }
    let end = cursor + 1;
    while (end < characters.length && RANK_TAG_CHARACTER.test(characters[end] ?? "")) end += 1;
    const tag = characters.slice(cursor + 1, end).join("");
    if (
      tag.length === 0 ||
      tag.length > RANK_TAG_MAX_LENGTH ||
      isRankWordCharacter(characters[end])
    ) {
      cursor += 1;
      continue;
    }
    keys.add(tag.toLowerCase());
    if (keys.size >= maxKeys) return;
    cursor = end;
  }
}

export function extractRankHashtagKeys(
  texts: Iterable<string | null | undefined>,
  maxKeys = 200,
): string[] {
  const keys = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    rankHashtagKeysIn(text, keys, maxKeys);
    if (keys.size >= maxKeys) break;
  }
  return [...keys];
}

/** One SQL-sourced candidate: the post, its counts, and its surfacing event. */
interface RankCandidate {
  postId: string;
  authorId: string;
  content: string;
  createdAt: Date;
  reposterId: string | null;
  eventAt: Date;
  likeCount: number;
  repostCount: number;
  replyCount: number;
}

/** SQL prefilters are supersets; only exact matches consume the candidate budget. */
async function collectRankCandidates(
  fetchPage: (after: RankCandidate | undefined) => Promise<RankCandidate[]>,
  gameHashtagKey: string | undefined,
): Promise<RankCandidate[]> {
  const candidates: RankCandidate[] = [];
  let after: RankCandidate | undefined;
  while (candidates.length < FEED_RANK_POOL_LIMIT) {
    const rows = await fetchPage(after);
    for (const row of rows) {
      if (!gameHashtagKey || extractRankHashtagKeys([row.content]).includes(gameHashtagKey)) {
        candidates.push(row);
        if (candidates.length === FEED_RANK_POOL_LIMIT) return candidates;
      }
    }
    if (rows.length < FEED_RANK_POOL_LIMIT) break;
    after = rows.at(-1);
  }
  return candidates;
}

const candidateLikeCount = sql<number>`(
  select count(*) from ${postLike} where ${postLike.postId} = ${post.id}
)`;

const candidateRepostCount = sql<number>`(
  select count(*) from ${postRepost} where ${postRepost.postId} = ${post.id}
)`;

/**
 * Derived like `likeCount` above, over the post's own replies — the same
 * author-deleted exclusion the shared `replyCount` applies, so the feature
 * counts what a feed would render.
 */
const candidateReplyCount = sql<number>`(
  select count(*) from ${post} as reply
  where reply.parent_id = ${post.id} and reply.deleted_at is null
)`;

/** The repost arm's reposter — aliased because the original owns `post`/`user`. */
const rankReposter = alias(user, "rank_reposter");

/**
 * The block/ban visibility half of `invisibleAuthor` (./visibility.ts),
 * restated over an aliased `user` row — the same restatement posts.ts keeps
 * for its own repost arm. Must stay in step with it.
 */
function aliasHiddenFromViewer(
  viewerId: string,
  u: { id: unknown; banned: unknown; banExpires: unknown },
): ReturnType<typeof sql<boolean>> {
  return sql<boolean>`(
    (${u.banned} and (${u.banExpires} is null or ${u.banExpires} > cast(unixepoch('subsec') * 1000 as integer)))
    or exists (
      select 1 from ${userBlock}
      where ${userBlock.blockerId} = ${u.id} and ${userBlock.blockedId} = ${viewerId}
    )
    or exists (
      select 1 from ${userBlock}
      where ${userBlock.blockerId} = ${viewerId} and ${userBlock.blockedId} = ${u.id}
    )
  )`;
}

/**
 * The private-account half for an aliased reposter: a private account's
 * amplifications are visible only to themselves and their followers.
 */
function aliasPrivateHidden(
  viewerId: string,
  u: { id: unknown; isPrivate: unknown },
): ReturnType<typeof sql<boolean>> {
  return sql<boolean>`(
    ${u.isPrivate} is true
    and ${u.id} <> ${viewerId}
    and not exists (
      select 1 from ${follow}
      where ${follow.followerId} = ${viewerId} and ${follow.followingId} = ${u.id}
    )
  )`;
}

/**
 * Fetches the authored-post candidates for a scope: top-level, author-alive
 * posts inside the window, through the shared visibility filter. Repost
 * events join in `fetchRepostCandidates` under their own scope rules.
 */
async function fetchAuthoredCandidates(
  db: RankStore,
  args: {
    viewerId: string;
    scope: RankScope;
    cutoff: Date;
    q: string | undefined;
    gameHashtagKey: string | undefined;
  },
): Promise<RankCandidate[]> {
  const scopeFilter =
    args.scope === "following"
      ? sql`(${post.authorId} = ${args.viewerId} or exists (
            select 1 from ${follow}
            where ${follow.followingId} = ${post.authorId} and ${follow.followerId} = ${args.viewerId}
          ))`
      : args.scope === "discover"
        ? ne(post.authorId, args.viewerId)
        : undefined;
  return collectRankCandidates(async (after) => {
    const rows = await db
      .select({
        postId: post.id,
        authorId: post.authorId,
        content: post.content,
        createdAt: post.createdAt,
        likeCount: candidateLikeCount,
        repostCount: candidateRepostCount,
        replyCount: candidateReplyCount,
      })
      .from(post)
      .innerJoin(user, eq(user.id, post.authorId))
      .where(
        and(
          isNull(post.parentId),
          isNull(post.deletedAt),
          // Removed posts never rank: scoring invisible text would surface
          // words no reader may see, and the game filter would oracle them.
          isNull(post.removedAt),
          gte(post.createdAt, args.cutoff),
          args.q ? containsText(post.content, args.q) : undefined,
          // A selectivity prefilter only: the substring `#key` also
          // matches `#key2016`, so the collector checks exact tokens before
          // consuming the budget and scans further when necessary.
          args.gameHashtagKey ? containsText(post.content, `#${args.gameHashtagKey}`) : undefined,
          scopeFilter,
          not(invisibleAuthor(args.viewerId)),
          not(privatePostHidden(args.viewerId)),
          after
            ? sql`(${post.createdAt}, ${post.id}) < (${sql.param(after.eventAt, post.createdAt)}, ${after.postId})`
            : undefined,
        ),
      )
      .orderBy(desc(post.createdAt), desc(post.id))
      .limit(FEED_RANK_POOL_LIMIT);
    return rows.map((row) => ({
      ...row,
      reposterId: null,
      eventAt: row.createdAt,
    }));
  }, args.gameHashtagKey);
}

/**
 * The repost arm: recent repost events scored on the ORIGINAL's features
 * with the EVENT's timestamp for freshness. The window binds the event — an
 * ancient original may surface, but only on a recent amplification, which is
 * what bounds the freshness a repost can confer.
 *
 * Event actors per scope: Following carries only the viewer's and followed
 * accounts' amplifications; global and Discover take any visible reposter.
 * Originals keep the full visibility treatment (banned/blocked authors out,
 * private originals out for non-followers) plus the tombstone exclusion —
 * ranked recommendations never score invisible text. Discover additionally
 * excludes originals by the viewer.
 */
async function fetchRepostCandidates(
  db: RankStore,
  args: {
    viewerId: string;
    scope: RankScope;
    cutoff: Date;
    q: string | undefined;
    gameHashtagKey: string | undefined;
  },
): Promise<RankCandidate[]> {
  const reposterRule =
    args.scope === "following"
      ? sql`(${postRepost.userId} = ${args.viewerId} or exists (
              select 1 from ${follow}
              where ${follow.followingId} = ${postRepost.userId} and ${follow.followerId} = ${args.viewerId}
            ))`
      : undefined;
  // The original joins un-aliased, so the shared visibility predicates read
  // it directly — the same ban/block/privacy treatment authored candidates get.
  const originalAuthorRule =
    args.scope === "discover" ? ne(post.authorId, args.viewerId) : undefined;
  // Pick the latest visible amplification per original before limiting;
  // otherwise one viral post can consume the entire repost budget.
  const latestReposts = db
    .select({
      position: sql<number>`row_number() over (partition by ${post.id}
        order by ${postRepost.createdAt} desc, ${postRepost.userId} desc)`.as("position"),
      postId: post.id,
      authorId: post.authorId,
      content: post.content,
      createdAt: post.createdAt,
      reposterId: sql<string>`${rankReposter.id}`.as("reposter_id"),
      eventAt: sql<Date>`${postRepost.createdAt}`.mapWith(postRepost.createdAt).as("event_at"),
      likeCount: candidateLikeCount.as("like_count"),
      repostCount: candidateRepostCount.as("repost_count"),
      replyCount: candidateReplyCount.as("reply_count"),
    })
    .from(postRepost)
    .innerJoin(rankReposter, eq(rankReposter.id, postRepost.userId))
    .innerJoin(post, eq(post.id, postRepost.postId))
    .innerJoin(user, eq(user.id, post.authorId))
    .where(
      and(
        isNull(post.parentId),
        isNull(post.deletedAt),
        isNull(post.removedAt),
        gte(postRepost.createdAt, args.cutoff),
        args.q ? containsText(post.content, args.q) : undefined,
        args.gameHashtagKey ? containsText(post.content, `#${args.gameHashtagKey}`) : undefined,
        reposterRule,
        originalAuthorRule,
        not(invisibleAuthor(args.viewerId)),
        not(privatePostHidden(args.viewerId)),
        not(aliasHiddenFromViewer(args.viewerId, rankReposter)),
        not(aliasPrivateHidden(args.viewerId, rankReposter)),
      ),
    )
    .as("latest_rank_reposts");
  return collectRankCandidates(
    async (after) =>
      db
        .select()
        .from(latestReposts)
        .where(
          and(
            eq(latestReposts.position, 1),
            after
              ? sql`(${latestReposts.eventAt}, ${latestReposts.postId}) < (${sql.param(after.eventAt, postRepost.createdAt)}, ${after.postId})`
              : undefined,
          ),
        )
        .orderBy(desc(latestReposts.eventAt), desc(latestReposts.postId))
        .limit(FEED_RANK_POOL_LIMIT),
    args.gameHashtagKey,
  );
}

/** The viewer's bounded interest history — every signal the scorer reads. */
interface ViewerHistory {
  authorLikeCounts: Map<string, number>;
  authorRepostCounts: Map<string, number>;
  favoriteGameKeys: Set<string>;
  /** Generic tokens from reply-thread roots and immediate parents. */
  replyTopicKeys: Set<string>;
  /** Generic tokens from the viewer's recently liked posts. */
  likedTopicKeys: Set<string>;
  /** Generic tokens from the viewer's recently reposted posts. */
  repostedTopicKeys: Set<string>;
  hasAnyFollow: boolean;
}

/**
 * Reads the viewer's recent history, bounded per signal so a decade-old
 * account costs the same as a new one. Every post-derived input is filtered
 * to currently visible, non-tombstoned rows — hidden or removed content
 * lends no affinity and no topics. Replies contribute TOPIC interest only:
 * each recent reply climbs its thread (bounded depth) and the root +
 * immediate parent's tokens join the topic set once per thread — the
 * thread's author earns no endorsement from it. Bookmarks are never read.
 */
async function fetchViewerHistory(db: RankStore, viewerId: string): Promise<ViewerHistory> {
  const [likeRows, repostRows, favoriteRows, replyRows, followProbe] = await Promise.all([
    db
      .select({ postId: post.id, authorId: post.authorId })
      .from(postLike)
      .innerJoin(post, eq(post.id, postLike.postId))
      .innerJoin(user, eq(user.id, post.authorId))
      .where(
        and(
          eq(postLike.userId, viewerId),
          isNull(post.deletedAt),
          isNull(post.removedAt),
          not(invisibleAuthor(viewerId)),
          not(privatePostHidden(viewerId)),
        ),
      )
      .orderBy(desc(postLike.createdAt), desc(postLike.postId))
      .limit(FEED_RANK_HISTORY_LIMIT),
    db
      .select({ postId: post.id, authorId: post.authorId })
      .from(postRepost)
      .innerJoin(post, eq(post.id, postRepost.postId))
      .innerJoin(user, eq(user.id, post.authorId))
      .where(
        and(
          eq(postRepost.userId, viewerId),
          isNull(post.deletedAt),
          isNull(post.removedAt),
          not(invisibleAuthor(viewerId)),
          not(privatePostHidden(viewerId)),
        ),
      )
      .orderBy(desc(postRepost.createdAt))
      .limit(FEED_RANK_HISTORY_LIMIT),
    db
      .select({ hashtagKey: game.hashtagKey })
      .from(gameFavorite)
      .innerJoin(game, eq(game.igdbId, gameFavorite.gameId))
      .where(eq(gameFavorite.userId, viewerId))
      .orderBy(desc(gameFavorite.createdAt))
      .limit(FEED_RANK_HISTORY_LIMIT),
    db
      .select({ id: post.id, parentId: post.parentId })
      .from(post)
      .where(
        and(
          eq(post.authorId, viewerId),
          not(isNull(post.parentId)),
          isNull(post.deletedAt),
          isNull(post.removedAt),
        ),
      )
      .orderBy(desc(post.createdAt))
      .limit(FEED_RANK_HISTORY_LIMIT),
    db
      .select({ followingId: follow.followingId })
      .from(follow)
      .where(eq(follow.followerId, viewerId))
      .limit(1),
  ]);

  const authorLikeCounts = new Map<string, number>();
  for (const row of likeRows)
    authorLikeCounts.set(row.authorId, (authorLikeCounts.get(row.authorId) ?? 0) + 1);
  const authorRepostCounts = new Map<string, number>();
  for (const row of repostRows) {
    authorRepostCounts.set(row.authorId, (authorRepostCounts.get(row.authorId) ?? 0) + 1);
  }
  const favoriteGameKeys = new Set(favoriteRows.map((row) => row.hashtagKey));

  /** Live contents for a batch of history post ids — visible and tombstone-free, like above. */
  const visibleContents = async (postIds: readonly string[]): Promise<string[]> => {
    const distinct = [...new Set(postIds)];
    if (distinct.length === 0) return [];
    const rows = await db
      .select({ content: post.content })
      .from(post)
      .innerJoin(user, eq(user.id, post.authorId))
      .where(
        and(
          textIn(post.id, distinct),
          isNull(post.deletedAt),
          isNull(post.removedAt),
          not(invisibleAuthor(viewerId)),
          not(privatePostHidden(viewerId)),
        ),
      );
    return rows.map((row) => row.content);
  };
  const [likedContents, repostedContents] = await Promise.all([
    visibleContents(likeRows.map((row) => row.postId)),
    visibleContents(repostRows.map((row) => row.postId)),
  ]);
  const likedTopicKeys = new Set(
    extractRankHashtagKeys(likedContents, FEED_RANK_HISTORY_LIMIT * 2),
  );
  const repostedTopicKeys = new Set(
    extractRankHashtagKeys(repostedContents, FEED_RANK_HISTORY_LIMIT * 2),
  );

  // The thread walk: each reply climbs `parent_id` to its root. Batched per
  // level (not one CTE per reply) and depth-bounded, collecting the root +
  // immediate parent per thread exactly once.
  const topicPostIds = new Set<string>();
  if (replyRows.length > 0) {
    const parentOf = new Map<string, string | null>();
    let frontier = [
      ...new Set(replyRows.map((row) => row.parentId).filter((id): id is string => id !== null)),
    ];
    for (const row of replyRows) parentOf.set(row.id, row.parentId);
    let depth = 0;
    while (frontier.length > 0 && depth < FEED_RANK_THREAD_WALK_MAX_DEPTH) {
      const found = await db
        .select({ id: post.id, parentId: post.parentId })
        .from(post)
        .where(textIn(post.id, frontier));
      const next: string[] = [];
      for (const row of found) {
        parentOf.set(row.id, row.parentId);
        if (row.parentId && !parentOf.has(row.parentId)) next.push(row.parentId);
      }
      frontier = [...new Set(next)];
      depth += 1;
    }
    const seenThreads = new Set<string>();
    for (const reply of replyRows) {
      let current: string | null = reply.parentId;
      let root = reply.id;
      let steps = 0;
      while (current && steps <= FEED_RANK_THREAD_WALK_MAX_DEPTH) {
        root = current;
        const next: string | null | undefined = parentOf.get(current);
        if (next === undefined || next === null) break;
        current = next;
        steps += 1;
      }
      // One entry per thread: the root, plus the reply's immediate parent.
      // A missing parent row (a hard-deleted ancestor) simply ends the climb
      // at the deepest known post — the topics gathered are still the
      // thread's own.
      const threadKey = root;
      if (!seenThreads.has(threadKey)) {
        seenThreads.add(threadKey);
        topicPostIds.add(root);
        if (reply.parentId) topicPostIds.add(reply.parentId);
      } else if (reply.parentId) {
        topicPostIds.add(reply.parentId);
      }
    }
  }

  let replyTopicKeys = new Set<string>();
  if (topicPostIds.size > 0) {
    const topicContents = await visibleContents([...topicPostIds]);
    replyTopicKeys = new Set(extractRankHashtagKeys(topicContents, FEED_RANK_HISTORY_LIMIT * 2));
  }

  return {
    authorLikeCounts,
    authorRepostCounts,
    favoriteGameKeys,
    replyTopicKeys,
    likedTopicKeys,
    repostedTopicKeys,
    hasAnyFollow: followProbe.length > 0,
  };
}

/** Exact follow membership for a batch of authors — history bounds never apply here. */
async function fetchFollowedAuthors(
  db: RankStore,
  viewerId: string,
  authorIds: readonly string[],
): Promise<Set<string>> {
  const distinct = [...new Set(authorIds)];
  if (distinct.length === 0) return new Set();
  const rows = await db
    .select({ followingId: follow.followingId })
    .from(follow)
    .where(and(eq(follow.followerId, viewerId), textIn(follow.followingId, distinct)));
  return new Set(rows.map((row) => row.followingId));
}

/** Whether a bounded history marks a warm start — the `hasInterests` reader. */
function hasAnyHistory(history: ViewerHistory): boolean {
  return (
    history.favoriteGameKeys.size > 0 ||
    history.replyTopicKeys.size > 0 ||
    history.authorLikeCounts.size > 0 ||
    history.authorRepostCounts.size > 0 ||
    history.hasAnyFollow
  );
}

/**
 * Builds and stores a ranked snapshot: sources bounded candidates (7-day
 * window, widened to 30 days when sparse), scores them in JS through the one
 * scorer, applies the diversity penalty, and freezes the order.
 */
export async function buildRankSnapshot(
  db: Database,
  args: {
    viewerId: string;
    scope: RankScope;
    q: string | undefined;
    gameSlug: string | undefined;
  },
): Promise<{
  id: string;
  expiresAt: Date;
  items: FeedRankSnapshotItem[];
  hasInterests: boolean;
  gameHashtagKey: string | null;
}> {
  let gameHashtagKey: string | null = null;
  // History starts alongside the slug lookup so the unknown-slug branch
  // below can still report `hasInterests` truthfully for its empty snapshot.
  const history = fetchViewerHistory(db, args.viewerId);
  if (args.gameSlug) {
    const [matched] = await db
      .select({ hashtagKey: game.hashtagKey })
      .from(game)
      .where(eq(game.slug, args.gameSlug))
      .limit(1);
    // An unknown slug is an empty snapshot, never NOT_FOUND — a stale shared
    // URL renders the empty state, the same rule the chronological Discover
    // applies. It is still stored, so resumes and the ranking metadata work.
    if (!matched) {
      const viewerHistory = await history;
      return persistRankSnapshot(db, {
        viewerId: args.viewerId,
        scope: args.scope,
        q: args.q,
        gameSlug: args.gameSlug,
        gameHashtagKey: null,
        items: [],
        hasInterests: hasAnyHistory(viewerHistory),
      });
    }
    gameHashtagKey = matched.hashtagKey;
  }

  const windowCutoff = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const collect = async (days: number): Promise<RankCandidate[]> => {
    const cutoff = windowCutoff(days);
    const armArgs = {
      viewerId: args.viewerId,
      scope: args.scope,
      cutoff,
      q: args.q,
      gameHashtagKey: gameHashtagKey ?? undefined,
    };
    const [authored, reposts] = await Promise.all([
      fetchAuthoredCandidates(db, armArgs),
      fetchRepostCandidates(db, armArgs),
    ]);
    // Deduplicate originals: one entry per post, keeping the latest
    // surfacing event and its reposter — the relevant amplification.
    const byPost = new Map<string, RankCandidate>();
    for (const candidate of [...authored, ...reposts]) {
      const current = byPost.get(candidate.postId);
      if (!current || candidate.eventAt.getTime() > current.eventAt.getTime()) {
        byPost.set(candidate.postId, candidate);
      }
    }
    // Both arms already contain exact matches. The merged pool holds at
    // most 500 distinct rankable candidates, never 500 per arm.
    const scoped = [...byPost.values()];
    scoped.sort(
      (a, b) =>
        b.eventAt.getTime() - a.eventAt.getTime() ||
        (a.postId < b.postId ? -1 : 1) ||
        (a.reposterId ?? "").localeCompare(b.reposterId ?? ""),
    );
    return scoped.slice(0, FEED_RANK_POOL_LIMIT);
  };

  // The sparse check runs on the rankable set — after the exact-token pass —
  // so a filtered page widens its window rather than ranking a thin pool.
  let candidates = await collect(FEED_RANK_WINDOW_DAYS);
  if (candidates.length < FEED_RANK_SPARSE_THRESHOLD) {
    candidates = await collect(FEED_RANK_WINDOW_MAX_DAYS);
  }

  const viewerHistory = await history;
  const followedAuthors = await fetchFollowedAuthors(
    db,
    args.viewerId,
    candidates.map((candidate) => candidate.authorId),
  );

  const now = rankBucketedNow();
  const scored = candidates.map((candidate) => {
    const postKeys = extractRankHashtagKeys([candidate.content]);
    let favoriteOverlap = 0;
    let replyOverlap = 0;
    let likedOverlap = 0;
    let repostedOverlap = 0;
    for (const key of postKeys) {
      if (viewerHistory.favoriteGameKeys.has(key)) favoriteOverlap += 1;
      if (viewerHistory.replyTopicKeys.has(key)) replyOverlap += 1;
      if (viewerHistory.likedTopicKeys.has(key)) likedOverlap += 1;
      if (viewerHistory.repostedTopicKeys.has(key)) repostedOverlap += 1;
    }
    const score = scorePost({
      favoriteGameOverlap: favoriteOverlap,
      replyTopicOverlap: replyOverlap,
      authorLikedPosts: viewerHistory.authorLikeCounts.get(candidate.authorId) ?? 0,
      likedTopicOverlap: likedOverlap,
      followsAuthor:
        candidate.authorId === args.viewerId || followedAuthors.has(candidate.authorId),
      authorRepostedPosts: viewerHistory.authorRepostCounts.get(candidate.authorId) ?? 0,
      repostedTopicOverlap: repostedOverlap,
      likeCount: candidate.likeCount,
      repostCount: candidate.repostCount,
      replyCount: candidate.replyCount,
      eventAgeHours: Math.max((now.getTime() - candidate.eventAt.getTime()) / 3_600_000, 0),
    });
    return { candidate, score };
  });

  // Pure score orders first (ties by post id, deterministically); the
  // diversity penalty then re-orders post-hoc.
  scored.sort((a, b) => b.score - a.score || (a.candidate.postId < b.candidate.postId ? -1 : 1));
  const ordered = diversifyScores(scored, {
    authorOf: (entry) => entry.candidate.authorId,
    scoreOf: (entry) => entry.score,
    keyOf: (entry) => entry.candidate.postId,
  });

  const items: FeedRankSnapshotItem[] = ordered.map((entry) => ({
    postId: entry.candidate.postId,
    reposterId: entry.candidate.reposterId,
    eventAt: entry.candidate.eventAt.toISOString(),
  }));

  const hasInterests = hasAnyHistory(viewerHistory);

  return persistRankSnapshot(db, {
    viewerId: args.viewerId,
    scope: args.scope,
    q: args.q,
    gameSlug: args.gameSlug,
    gameHashtagKey,
    items,
    hasInterests,
  });
}

async function persistRankSnapshot(
  db: Database,
  args: {
    viewerId: string;
    scope: RankScope;
    q: string | undefined;
    gameSlug: string | undefined;
    gameHashtagKey: string | null;
    items: FeedRankSnapshotItem[];
    hasInterests: boolean;
  },
): Promise<{
  id: string;
  expiresAt: Date;
  items: FeedRankSnapshotItem[];
  hasInterests: boolean;
  gameHashtagKey: string | null;
}> {
  const id = crypto.randomUUID();
  const now = sql`cast(unixepoch('subsec') * 1000 as integer)`;
  const [inserted] = await db.batch([
    db
      .insert(feedRankSnapshot)
      .values({
        id,
        viewerId: args.viewerId,
        scope: args.scope,
        q: args.q ?? null,
        gameSlug: args.gameSlug ?? null,
        gameHashtagKey: args.gameHashtagKey,
        items: args.items,
        hasInterests: args.hasInterests,
        expiresAt: sql`${now} + ${FEED_RANK_SNAPSHOT_TTL_MS}`,
      })
      .returning({ id: feedRankSnapshot.id, expiresAt: feedRankSnapshot.expiresAt }),
    // Subquery selection and deletion share the batch: no stale list or
    // interactive lock is needed between concurrent builds.
    db.delete(feedRankSnapshot).where(sql`${feedRankSnapshot.id} in (
      select id from feed_rank_snapshot where expires_at <= ${now}
      order by expires_at, id limit 100
    )`),
    db
      .delete(feedRankSnapshot)
      .where(
        and(
          eq(feedRankSnapshot.viewerId, args.viewerId),
          sql`${feedRankSnapshot.expiresAt} <= ${now}`,
        ),
      ),
    // A build adds one row; removing at most one overflow preserves the cap.
    // Protect the new row explicitly when expiries tie at millisecond precision.
    db.delete(feedRankSnapshot).where(sql`${feedRankSnapshot.id} in (
      select id from feed_rank_snapshot
      where viewer_id = ${args.viewerId} and id <> ${id}
      order by expires_at desc, id desc
      limit 1 offset ${FEED_RANK_MAX_SNAPSHOTS_PER_VIEWER - 1}
    )`),
  ]);
  const row = inserted[0];
  if (!row) {
    throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Failed to build ranking." });
  }
  return {
    id: row.id,
    expiresAt: row.expiresAt,
    items: args.items,
    hasInterests: args.hasInterests,
    gameHashtagKey: args.gameHashtagKey,
  };
}

export interface LoadedRankSnapshot {
  id: string;
  scope: RankScope;
  q: string | null;
  gameSlug: string | null;
  gameHashtagKey: string | null;
  items: FeedRankSnapshotItem[];
  hasInterests: boolean;
  expiresAt: Date;
}

function invalidSnapshot(): never {
  throw new ORPCError("BAD_REQUEST", { message: RANK_SNAPSHOT_INVALID_MESSAGE });
}

/**
 * Loads a snapshot for resumption: unknown ids, foreign viewers,
 * scope/filter mismatches, and expired rows all refuse with the same
 * explicit error — never a silent restart under a fresh ordering.
 */
export async function loadRankSnapshot(
  db: RankStore,
  args: {
    viewerId: string;
    snapshotId: string;
    scope: RankScope;
    q: string | undefined;
    gameSlug: string | undefined;
  },
): Promise<LoadedRankSnapshot> {
  const [row] = await db
    .select()
    .from(feedRankSnapshot)
    .where(
      and(
        eq(feedRankSnapshot.id, args.snapshotId),
        gt(feedRankSnapshot.expiresAt, sql`cast(unixepoch('subsec') * 1000 as integer)`),
      ),
    )
    .limit(1);
  if (!row || row.viewerId !== args.viewerId) invalidSnapshot();
  if (row.scope !== args.scope) invalidSnapshot();
  if ((args.q ?? null) !== row.q || (args.gameSlug ?? null) !== row.gameSlug) invalidSnapshot();
  return {
    id: row.id,
    scope: row.scope,
    q: row.q,
    gameSlug: row.gameSlug,
    gameHashtagKey: row.gameHashtagKey,
    items: row.items,
    hasInterests: row.hasInterests,
    expiresAt: row.expiresAt,
  };
}

/**
 * Discover's follow suggestions: the FIRST three distinct authors in the
 * frozen order — no refills. The selection walks the snapshot once, keeping
 * authors whose representative post is alive, visible to the viewer
 * (private-hidden authors are out — a suggestion must be followable
 * directly), and still matching the page's filters; the viewer's live follow/request state then
 * drops entries without replacement, so a follow placed after the build
 * hides its author until the next snapshot. No extra ranker — snapshot
 * position IS the rank.
 */
export async function suggestRankAuthorIds(
  db: RankStore,
  viewerId: string,
  items: readonly FeedRankSnapshotItem[],
  filters: { q: string | undefined; gameHashtagKey: string | null },
  limit: number = FEED_RANK_SUGGESTION_LIMIT,
): Promise<string[]> {
  const scan = items.slice(0, FEED_RANK_SUGGESTION_SCAN_LIMIT);
  const postIds = [...new Set(scan.map((item) => item.postId))];
  if (postIds.length === 0) return [];
  const rows = await db
    .select({ postId: post.id, authorId: post.authorId, content: post.content })
    .from(post)
    .innerJoin(user, eq(user.id, post.authorId))
    .where(
      and(
        textIn(post.id, postIds),
        filters.q ? containsText(post.content, filters.q) : undefined,
        isNull(post.deletedAt),
        isNull(post.removedAt),
        not(invisibleAuthor(viewerId)),
        not(privatePostHidden(viewerId)),
      ),
    );
  const rowByPost = new Map(rows.map((row) => [row.postId, row]));
  const picked: string[] = [];
  const seen = new Set<string>();
  for (const item of scan) {
    if (picked.length >= limit) break;
    const row = rowByPost.get(item.postId);
    if (!row || seen.has(row.authorId)) continue;
    seen.add(row.authorId);
    if (
      filters.gameHashtagKey &&
      !extractRankHashtagKeys([row.content]).includes(filters.gameHashtagKey)
    ) {
      continue;
    }
    picked.push(row.authorId);
  }
  const candidates = picked.filter((authorId) => authorId !== viewerId);
  if (candidates.length === 0) return [];
  const [followed, requested] = await Promise.all([
    fetchFollowedAuthors(db, viewerId, candidates),
    db
      .select({ targetId: followRequest.targetId })
      .from(followRequest)
      .where(
        and(eq(followRequest.requesterId, viewerId), textIn(followRequest.targetId, candidates)),
      ),
  ]);
  const requestedIds = new Set(requested.map((row) => row.targetId));
  return candidates.filter((authorId) => !followed.has(authorId) && !requestedIds.has(authorId));
}
