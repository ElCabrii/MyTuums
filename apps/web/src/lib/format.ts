const DIVISIONS: { amount: number; unit: Intl.RelativeTimeFormatUnit }[] = [
  { amount: 60, unit: "second" },
  { amount: 60, unit: "minute" },
  { amount: 24, unit: "hour" },
  { amount: 7, unit: "day" },
  { amount: 4.34524, unit: "week" },
  { amount: 12, unit: "month" },
  { amount: Number.POSITIVE_INFINITY, unit: "year" },
];

const relativeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** "just now", "3 minutes ago", "2 days ago" — for post timestamps. */
export function formatRelativeTime(date: Date): string {
  let duration = (date.getTime() - Date.now()) / 1000;

  if (Math.abs(duration) < 30) return "just now";

  for (const { amount, unit } of DIVISIONS) {
    if (Math.abs(duration) < amount) {
      return relativeFormatter.format(Math.round(duration), unit);
    }
    duration /= amount;
  }

  return date.toLocaleDateString();
}

const joinDateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "long",
  year: "numeric",
});

/** "Joined August 2026" — month precision is all a profile needs. */
export function formatJoinDate(date: Date): string {
  return joinDateFormatter.format(date);
}
