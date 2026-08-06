const DIVISIONS: { amount: number; unit: Intl.RelativeTimeFormatUnit }[] = [
  { amount: 60, unit: "second" },
  { amount: 60, unit: "minute" },
  { amount: 24, unit: "hour" },
  { amount: 7, unit: "day" },
  { amount: 4.34524, unit: "week" },
  { amount: 12, unit: "month" },
  { amount: Number.POSITIVE_INFINITY, unit: "year" },
];

/** "just now", "3 minutes ago", "2 days ago" — for post timestamps. */
export function formatRelativeTime(date: Date, locale?: string, justNow = "just now"): string {
  const relativeFormatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  let duration = (date.getTime() - Date.now()) / 1000;

  if (Math.abs(duration) < 30) return justNow;

  for (const { amount, unit } of DIVISIONS) {
    if (Math.abs(duration) < amount) {
      return relativeFormatter.format(Math.round(duration), unit);
    }
    duration /= amount;
  }

  return date.toLocaleDateString(locale);
}

/** "Joined August 2026" — month precision is all a profile needs. */
export function formatJoinDate(date: Date, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    month: "long",
    year: "numeric",
  }).format(date);
}

/**
 * "42", "1.2K", "3.4M" — for follower counts, which are read at a glance
 * rather than audited. Compact notation already leaves 0-999 alone, so there
 * is no threshold to special-case.
 */
export function formatCount(value: number, locale?: string): string {
  return new Intl.NumberFormat(locale, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

/**
 * "6 Aug 2026, 14:30" — for moderation deadlines, where relative time ("in 3
 * days") is too vague for a suspension the user needs to plan around.
 */
export function formatDateTime(date: Date, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}
