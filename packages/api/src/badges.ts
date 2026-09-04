// The profile badge catalog (issue #308): ids, families and thresholds as one
// dependency-free definition, shared by the server (stamping and display
// selection) and the browser (rendering). Exposed under its own package
// subpath (`@my-tuums/api/badges`) for the same reason `./constants` is:
// importing from the package root would drag ./router.js -> @my-tuums/db into
// the browser bundle, where that module's `DATABASE_URL` check throws on
// import.
//
// Every badge is a stamped achievement: a `user_badge` row written the moment
// the badge is earned and never withdrawn. Losing one is not an outcome the
// model has — a count that recedes below its threshold takes no badge with
// it, so nothing is ever re-derived from live state on a profile read. The
// display set is selected from the stamped rows alone: the highest tier per
// tiered family, plus the flat badges, in canonical order.
//
// Display names are NOT here — they live in the web app's Paraglide messages
// keyed by badge id (`badge_<id>`), because the API never speaks them and a
// copy here would be a second source of translated truth.

/** The thirteen badge ids — the wire vocabulary of `badges: BadgeId[]`. */
export type BadgeId =
  // Follower tiers — one upgrading badge: stamped by the follow that first
  // passes the threshold, raised to the next tier by the follow that passes
  // it, kept even if followers unfollow and the count recedes.
  | "popular"
  | "rising_star"
  | "star"
  | "superstar"
  | "supernova"
  // Post-like tiers — one upgrading badge per account, measured by the
  // author's most-liked post: stamped when a post first passes a threshold
  // and raised by whichever post passes the next one, kept even if likes
  // recede.
  | "noticed"
  | "trendy"
  | "big"
  | "exploding"
  | "giant"
  // Granted manually to the three founder accounts, out of band (no API,
  // no UI).
  | "founder"
  // Join badges — tiers of one family, stamped exclusively at account
  // creation from the creation rank (packages/db/src/stamp-join-badges.ts):
  // the first 50 accounts carry super-early alone, the 51st through 999th
  // carry early alone, and nothing later can change it.
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
 * literally — a tier is earned strictly above its threshold, and stamped by
 * the `user.follow` whose insert first put the count there; whichever follow
 * later puts the count past the next threshold raises the badge to that
 * tier. `unfollow` never unstamps: the tier was genuinely reached, and
 * whether the count still stands is not part of what the badge claims.
 */
export const FOLLOWER_BADGE_TIERS: readonly BadgeTier[] = [
  { id: "popular", threshold: 1_000 },
  { id: "rising_star", threshold: 10_000 },
  { id: "star", threshold: 100_000 },
  { id: "superstar", threshold: 1_000_000 },
  { id: "supernova", threshold: 10_000_000 },
];

/**
 * Post-like tiers, ascending, measured by the author's most-liked post.
 * Stamped when one of the author's posts first passes a threshold, and
 * raised by whichever post first passes the next one — kept even if likes
 * recede.
 */
export const POST_LIKE_BADGE_TIERS: readonly BadgeTier[] = [
  { id: "noticed", threshold: 10_000 },
  { id: "trendy", threshold: 100_000 },
  { id: "big", threshold: 1_000_000 },
  { id: "exploding", threshold: 10_000_000 },
  { id: "giant", threshold: 100_000_000 },
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
 * The input is raw `user_badge` ids. Tiered badges upgrade rather than
 * accumulate (one row per family, raised by the crossing that earns the next
 * tier — see ./badge-stamping.ts), so selecting the family's highest stamped
 * tier is normally choosing among one; it stays the authority anyway,
 * because a rare upgrade race can transiently leave a superseded row
 * beside its replacement. Unknown ids (a row written before a catalog
 * change) are ignored rather than surfaced.
 */
export function displayProfileBadges(input: { stampedBadgeIds: readonly string[] }): BadgeId[] {
  const stamped = new Set(input.stampedBadgeIds);

  const badges: (BadgeId | null)[] = [
    highestStampedTier(stamped, FOLLOWER_BADGE_TIERS),
    highestStampedTier(stamped, POST_LIKE_BADGE_TIERS),
    stamped.has("founder") ? ("founder" as const) : null,
    stamped.has("super_early_access") ? ("super_early_access" as const) : null,
    stamped.has("early_access") ? ("early_access" as const) : null,
  ];
  return badges.filter((badge): badge is BadgeId => badge !== null);
}

function highestStampedTier(stamped: Set<string>, tiers: readonly BadgeTier[]): BadgeId | null {
  for (const tier of [...tiers].reverse()) {
    if (stamped.has(tier.id)) return tier.id;
  }
  return null;
}
