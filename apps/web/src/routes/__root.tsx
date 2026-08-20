import { createRootRoute, Outlet } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { useAtomValue } from "jotai";
import { Header } from "@/components/header";
import { Footer } from "@/components/footer";
import { NotFoundPage } from "@/components/not-found-page";
import { LegalConsentDialog } from "@/components/legal-consent-dialog";
import { themeClassEffect } from "@/atoms/theme";
import { localeDocumentEffect, localePreferenceEffect } from "@/atoms/locale";
import { isSignedInAtom, sessionSettledAtom, sessionSettledEffect } from "@/atoms/session";
import { useRequireHandle } from "@/hooks/use-require-handle";
import { useRequireSignedIn } from "@/hooks/use-require-signed-in";

// The moderation dialogs open from a kebab anywhere (post cards, profile
// pages) yet must exist in exactly one place: they are bound to shared
// identity atoms, so a second mounted instance would stack a second dialog
// on top of the first. Lazy, like the ModeToggle in the header — the dialogs
// are only ever useful to someone who clicks Report or Block, so their chunk
// (the Select, the mutations, the reason-code labels) stays out of first
// paint. The named exports are mapped to `default` so the dynamic modules can
// render as lazy components.
const ReportDialog = lazy(() =>
  import("@/components/moderation/report-dialog").then((mod) => ({ default: mod.ReportDialog })),
);
const BlockDialog = lazy(() =>
  import("@/components/moderation/block-dialog").then((mod) => ({ default: mod.BlockDialog })),
);

export const Route = createRootRoute({
  component: RootLayout,
  // Rendered through this layout's own <Outlet/>, so an unmatched URL gets
  // the normal header/footer chrome instead of the router's bare default.
  notFoundComponent: NotFoundPage,
});

function RootLayout() {
  // Mounts the theme side effect for the lifetime of the app — see
  // src/atoms/theme.ts. `atomEffect` atoms resolve to `void`; the value is
  // never used, only the subscription its `useAtomValue` establishes.
  useAtomValue(themeClassEffect);
  useAtomValue(localeDocumentEffect);

  // Applies the account's stored language on a device that has never chosen
  // one — see src/atoms/locale.ts. Unlike the theme, which `themeAtom` resolves
  // on read, this has to be an effect because switching locale reloads the
  // document.
  useAtomValue(localePreferenceEffect);

  // Latches `sessionSettledAtom` on the first /get-session landing. Mounted
  // here (before the splash branch below) so the latch is alive even while
  // the splash is the only thing on screen.
  useAtomValue(sessionSettledEffect);

  // Here rather than per-route so no future route can forget it: an OAuth
  // sign-up with no handle yet is sent to /welcome from wherever it lands.
  useRequireHandle();

  // The site is private — a signed-out visitor on any non-auth page is sent
  // to /login with their destination preserved in ?redirect=.
  useRequireSignedIn();

  // All reads live above the splash branch below — a hook called after a
  // conditional return would be a rules-of-hooks violation the moment the
  // splash unmounts.
  const settled = useAtomValue(sessionSettledAtom);
  const signedIn = useAtomValue(isSignedInAtom);

  // While the first /get-session is in flight this renders nothing: the
  // splash is static markup in index.html (`#app-splash`), already painted
  // before the bundle loaded and removed by `sessionSettledEffect` the moment
  // the session lands. `<Outlet/>` not rendering means no route fires its
  // queries against a session that is about to change under it — this is the
  // fix for the signed-out flash on cold load, see sessionSettledAtom.
  if (!settled) return null;

  // The header renders only for a real session — never the Log in / Register
  // chrome. Signed-out visitors (on /login and friends) get a bare page; see
  // header.tsx, which narrows `viewerAtom` rather than branching on it.

  return (
    <div className="bg-background text-foreground flex min-h-screen flex-col antialiased">
      {signedIn && <Header />}
      <main className="flex-1">
        <Outlet />
      </main>
      <Footer />
      {/* Mounted here, not per-call-site: the dialogs own the shared
          `reportDialogAtom`/`blockDialogAtom` identities, and every kebab and
          profile menu only sets the target. The Suspense fallback is null —
          the dialogs are closed until a target lands, so there is nothing to
          flash. */}
      <Suspense fallback={null}>
        <ReportDialog />
        <BlockDialog />
      </Suspense>
      {/* Mounted unconditionally: the dialog owns the whole decision — signed
          in, consent missing or stale, and not currently on one of the legal
          documents itself. Duplicating half of that here would let the two
          drift. */}
      <LegalConsentDialog />
    </div>
  );
}
