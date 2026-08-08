import { Ban } from "lucide-react";
import { PageCard } from "@/components/page-card";
import { m } from "@/paraglide/messages.js";

/**
 * The full-screen banned-account screen (issue #74).
 *
 * Styled after the cold-load splash (`#app-splash` in `index.html`) — a
 * fixed, full-viewport, centered logo — but as a real React route rather than
 * static markup, because unlike the splash this copy has to be localized:
 * `#app-splash` ships before Paraglide's bundle has even parsed, which is
 * exactly why it is deliberately English-only. `fixed inset-0` is what covers
 * the header/footer chrome `__root.tsx` still renders underneath (the footer
 * mounts on every route, signed in or not) — a banned visitor should see
 * nothing but this screen, the same way the splash hides everything before it.
 *
 * Reached from exactly two places, both of which navigate here instead of
 * rendering the generic sign-in-failed banner: the OAuth callback's
 * `error=BANNED_USER` (handled in `/login`) and `signInAtom` /
 * `signInWithPasskeyAtom` reporting a `"banned"` outcome for the
 * password/username/passkey paths. Both consume their error once and leave
 * no query param behind, so this URL is always exactly `/banned`.
 */
export function BannedPage() {
  return (
    <div className="bg-background fixed inset-0 z-10 flex flex-col items-center justify-center gap-6 px-4 text-center">
      <img
        src="/mytuums.svg"
        alt={m.app_logo_alt()}
        width={2048}
        height={2048}
        className="h-14 w-auto"
      />
      <PageCard className="max-w-md space-y-3">
        <Ban className="text-destructive mx-auto h-10 w-10" aria-hidden="true" />
        <h1 className="text-xl font-bold tracking-tight">{m.banned_title()}</h1>
        <p className="text-muted-foreground text-sm">{m.banned_body()}</p>
      </PageCard>
    </div>
  );
}
