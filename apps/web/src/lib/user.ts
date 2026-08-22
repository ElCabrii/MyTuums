/**
 * The handle used in URLs (`/@alexmercer`). Prefers the canonical `username`
 * that the BetterAuth username plugin normalises over `displayUsername`.
 * New rows keep both fields identical; the fallback remains for handle rows
 * created before the canonical username field existed.
 */
export function handleOf(
  user: { username?: string | null; displayUsername?: string | null } | null | undefined,
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
