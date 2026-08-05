import { APP_STAGE } from "@/lib/app-version";

/**
 * The alpha/beta stage marker next to the header wordmark.
 *
 * Header only, and only while the version is pre-1.0 — the footer's plain
 * "v0.4.2" stands alone, and a stable release needs no badge. Styled after
 * LastUsedBadge (sign-in-options.tsx) so the two pills read as one system.
 */
export function VersionTag() {
  if (APP_STAGE === null) return null;
  return (
    <span className="shrink-0 whitespace-nowrap rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
      {APP_STAGE}
    </span>
  );
}
