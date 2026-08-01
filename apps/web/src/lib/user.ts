/**
 * The handle used in URLs (`/@alexmercer`). Prefers the canonical `username`
 * that the BetterAuth username plugin normalises over `displayUsername`, so
 * links stay stable even when the two differ in casing.
 */
export function handleOf(
  user: { username?: string | null; displayUsername?: string | null } | null | undefined
): string | null {
  return user?.username ?? user?.displayUsername ?? null;
}

/** Up to two initials for avatar fallbacks. */
export function initialsOf(name: string | null | undefined): string {
  if (!name) return "U";
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
  return initials || "U";
}
