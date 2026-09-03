// The profile badge catalog (issue #308): ids, families and thresholds as one
// dependency-free definition, shared by the server (derivation and stamping)
// and the browser (rendering). Exposed under its own package subpath
// (`@my-tuums/api/badges`) for the same reason `./constants` is: importing
// from the package root would drag ./router.js -> @my-tuums/db into the
// browser bundle, where that module's `DATABASE_URL` check throws on import.
//
// Display names are NOT here — they live in the web app's Paraglide messages
// keyed by badge id (`badge_<id>`), because the API never speaks them and a
// copy here would be a second source of translated truth.

/** The thirteen badge ids — the wire vocabulary of `badges: BadgeId[]`. */
export type BadgeId =
  // Follower tiers — live state, derived from the current follower count.
  | "popular"
  | "rising_star"
  | "star"
  | "superstar"
  | "supernova"
  // Post-like tiers — achievements, stamped when a post's like count first
  // passes the threshold and kept even if likes recede.
  | "noticed"
  | "trendy"
  | "big"
  | "exploding"
  | "giant"
  // Granted manually to exactly one account, out of band (no API, no UI).
  | "founder"
  // Join badges — static, derived from the account's creation rank.
  | "super_early_access"
  | "early_access";

/** The four families. Only the tiered ones display their highest earned tier. */
export type BadgeFamily = "followers" | "post-likes" | "join" | "founder";

/** One tier of a tiered family: earned when the measured count passes `threshold`. */
export interface BadgeTier {
  id: BadgeId;
  threshold: number;
}

/**
 * Follower tiers, ascending. "More than X people follow you" is read
 * literally — a tier is earned strictly above its threshold, and because the
 * tier is derived from the live count at profile read time, a count that
 * drops back below the threshold takes the badge with it.
 */
export const FOLLOWER_BADGE_TIERS: readonly BadgeTier[] = [
  { id: "popular", threshold: 1_000 },
  { id: "rising_star", threshold: 10_000 },
  { id: "star", threshold: 100_000 },
  { id: "superstar", threshold: 1_000_000 },
  { id: "supernova", threshold: 10_000_000 },
];

/**
 * Post-like tiers, ascending. Stamped when one of an author's posts first
 * passes a threshold — an achievement, kept even if the post's likes recede.
 */
export const POST_LIKE_BADGE_TIERS: readonly BadgeTier[] = [
  { id: "noticed", threshold: 10_000 },
  { id: "trendy", threshold: 100_000 },
  { id: "big", threshold: 1_000_000 },
  { id: "exploding", threshold: 10_000_000 },
  { id: "giant", threshold: 100_000_000 },
];

/**
 * Join-badge ranks: among the first 50 / first 1,000 accounts by creation
 * order. A rank is how many accounts were created strictly before this one,
 * so "among the first 50" is `rank < 50`.
 */
export const SUPER_EARLY_ACCESS_RANK = 50;
export const EARLY_ACCESS_RANK = 1_000;

/**
 * The ids that live in `user_badge` rows. Follower tiers and join badges are
 * derived at read time and never stamped; this is also the `user_badge.badge`
 * check constraint's list (packages/db/src/schema/app.ts — keep in step).
 */
export const STAMPED_BADGE_IDS: readonly BadgeId[] = [
  ...POST_LIKE_BADGE_TIERS.map((tier) => tier.id),
  "founder",
];

/** Every id in the catalog, in canonical display order. */
export const BADGE_IDS: readonly BadgeId[] = [
  ...FOLLOWER_BADGE_TIERS.map((tier) => tier.id),
  ...POST_LIKE_BADGE_TIERS.map((tier) => tier.id),
  "founder",
  "super_early_access",
  "early_access",
];

/** The highest follower tier a count strictly above threshold earns, if any. */
export function followerBadgeTierFor(followerCount: number): BadgeId | null {
  return highestTierAt(followerCount, FOLLOWER_BADGE_TIERS);
}

/** The highest post-like tier a like count strictly above threshold earns, if any. */
export function postLikeBadgeTierFor(likeCount: number): BadgeId | null {
  return highestTierAt(likeCount, POST_LIKE_BADGE_TIERS);
}

function highestTierAt(count: number, tiers: readonly BadgeTier[]): BadgeId | null {
  for (const tier of [...tiers].reverse()) {
    if (count > tier.threshold) return tier.id;
  }
  return null;
}

/** Both join badges a creation rank earns — the first 50 earn both. */
export function joinBadgeIdsFor(creationRank: number): BadgeId[] {
  const badges: BadgeId[] = [];
  if (creationRank < SUPER_EARLY_ACCESS_RANK) badges.push("super_early_access");
  if (creationRank < EARLY_ACCESS_RANK) badges.push("early_access");
  return badges;
}

const FOLLOWER_IDS = new Set<string>(FOLLOWER_BADGE_TIERS.map((tier) => tier.id));
const POST_LIKE_IDS = new Set<string>(POST_LIKE_BADGE_TIERS.map((tier) => tier.id));

/** Which family a badge belongs to — how the web app groups icon styles. */
export function badgeFamilyOf(id: BadgeId): BadgeFamily {
  if (FOLLOWER_IDS.has(id)) return "followers";
  if (POST_LIKE_IDS.has(id)) return "post-likes";
  if (id === "founder") return "founder";
  return "join";
}

/**
 * The display set a profile renders, in canonical order: follower tier, like
 * tier, founder, super-early, early.
 *
 * The stamped input is raw `user_badge` ids: every crossed like tier has its
 * own row, but only the family's highest tier displays — same rule as the
 * derived families. Unknown ids (a row written before a catalog change, or a
 * derived id that somehow landed in the table) are ignored rather than
 * surfaced.
 */
export function displayProfileBadges(input: {
  stampedBadgeIds: readonly string[];
  followerCount: number;
  creationRank: number;
}): BadgeId[] {
  const stamped = new Set(input.stampedBadgeIds);
  let likeTier: BadgeId | null = null;
  for (const tier of [...POST_LIKE_BADGE_TIERS].reverse()) {
    if (stamped.has(tier.id)) {
      likeTier = tier.id;
      break;
    }
  }

  const badges = [
    followerBadgeTierFor(input.followerCount),
    likeTier,
    stamped.has("founder") ? ("founder" as const) : null,
    ...joinBadgeIdsFor(input.creationRank),
  ];
  return badges.filter((badge): badge is BadgeId => badge !== null);
}
