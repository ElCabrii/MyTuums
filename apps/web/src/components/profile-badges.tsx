import type { ReactNode } from "react";
import type { BadgeId } from "@my-tuums/api/badges";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages.js";

/**
 * A profile's earned badges, one icon per badge (issue #308).
 *
 * The ids, families and canonical order come from `@my-tuums/api/badges` —
 * the one dependency-free catalog the server derives and stamps from — and
 * the API already returns the display set ordered, so this component renders
 * the array as given. Display names are Paraglide messages keyed by badge
 * id, never API data: the API never speaks them.
 *
 * Visual language: the two tiered families (followers, post-likes) share one
 * tier ramp — bronze, silver, gold, platinum, diamond — with a distinct
 * silhouette per family; the join badges share an emerald tone; founder is
 * deliberately unlike everything else (filled crown in the brand color, no
 * tier).
 */

/** The shared tier ramp for the tiered families, lowest to highest. */
const TIER_STYLE = [
  "text-amber-700 dark:text-amber-500", // bronze
  "text-slate-500 dark:text-slate-300", // silver
  "text-amber-500 dark:text-amber-400", // gold
  "text-cyan-600 dark:text-cyan-300", // platinum
  "text-fuchsia-500 dark:text-fuchsia-400", // diamond
] as const;

const JOIN_STYLE = "text-emerald-600 dark:text-emerald-400";
const FOUNDER_STYLE = "text-primary dark:text-primary";

/** The follower tiers' silhouette: an audience gathered around one person. */
const FOLLOWERS_MARK = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
);

/** The post-like tiers' silhouette: a like that landed. */
const HEART_MARK = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
  </svg>
);

/** The early-access join badge: having been there since the clock started. */
const CLOCK_MARK = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <circle cx="12" cy="12" r="10" />
    <polyline points="12 6 12 12 16 14" />
  </svg>
);

/** The super-early join badge: among the very first through the door. */
const ROCKET_MARK = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
    <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
    <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
    <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
  </svg>
);

/** Founder: the one hand-granted badge, unlike every earned tier. */
const FOUNDER_MARK = (
  <svg
    viewBox="0 0 24 24"
    fill="currentColor"
    fillOpacity="0.15"
    stroke="currentColor"
    strokeWidth="2"
    aria-hidden="true"
  >
    <path d="M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.735H5.81a1 1 0 0 1-.957-.735L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z" />
    <path d="M5 21h14" />
  </svg>
);

interface BadgeVisual {
  svg: ReactNode;
  className: string;
}

/** One SVG per badge, sharing the family's silhouette and the tier ramp. */
const BADGE_VISUALS = {
  popular: { svg: FOLLOWERS_MARK, className: TIER_STYLE[0] },
  rising_star: { svg: FOLLOWERS_MARK, className: TIER_STYLE[1] },
  star: { svg: FOLLOWERS_MARK, className: TIER_STYLE[2] },
  superstar: { svg: FOLLOWERS_MARK, className: TIER_STYLE[3] },
  supernova: { svg: FOLLOWERS_MARK, className: TIER_STYLE[4] },
  noticed: { svg: HEART_MARK, className: TIER_STYLE[0] },
  trendy: { svg: HEART_MARK, className: TIER_STYLE[1] },
  big: { svg: HEART_MARK, className: TIER_STYLE[2] },
  exploding: { svg: HEART_MARK, className: TIER_STYLE[3] },
  giant: { svg: HEART_MARK, className: TIER_STYLE[4] },
  founder: { svg: FOUNDER_MARK, className: FOUNDER_STYLE },
  super_early_access: { svg: ROCKET_MARK, className: JOIN_STYLE },
  early_access: { svg: CLOCK_MARK, className: JOIN_STYLE },
} satisfies Record<BadgeId, BadgeVisual>;

/** The localized display name of one badge — the messages are keyed by id. */
const BADGE_NAMES = {
  popular: m.badge_popular,
  rising_star: m.badge_rising_star,
  star: m.badge_star,
  superstar: m.badge_superstar,
  supernova: m.badge_supernova,
  noticed: m.badge_noticed,
  trendy: m.badge_trendy,
  big: m.badge_big,
  exploding: m.badge_exploding,
  giant: m.badge_giant,
  founder: m.badge_founder,
  super_early_access: m.badge_super_early_access,
  early_access: m.badge_early_access,
} satisfies Record<BadgeId, () => string>;

interface ProfileBadgesProps {
  /** The API's display set — already deduplicated to one tier per family, in canonical order. */
  badges: BadgeId[];
  /** Sizes every badge icon; the surfaces differ (profile header vs hover card). */
  iconClassName?: string;
  className?: string;
}

/**
 * Renders a profile's badges in the order the API returned them, each with
 * its localized name as the tooltip and the accessible label. Renders nothing
 * for an account with no badges — the vast majority — so profiles stay clean.
 */
export function ProfileBadges({ badges, iconClassName = "size-4", className }: ProfileBadgesProps) {
  if (badges.length === 0) return null;

  return (
    <ul className={cn("flex items-center gap-1", className)} aria-label={m.profile_badges_label()}>
      {badges.map((badge) => {
        const name = BADGE_NAMES[badge]();
        return (
          <li key={badge} className="shrink-0">
            <span
              role="img"
              aria-label={name}
              title={name}
              className={cn("block", iconClassName, BADGE_VISUALS[badge].className)}
            >
              {BADGE_VISUALS[badge].svg}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
