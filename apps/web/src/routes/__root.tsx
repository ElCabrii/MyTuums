import { createRootRoute, HeadContent, Outlet } from "@tanstack/react-router";
import { useEffect } from "react";
import { useAtomValue } from "jotai";
import { GlobalDialogs } from "@/components/global-dialogs";
import { Header } from "@/components/header";
import { Footer } from "@/components/footer";
import { NotFoundPage } from "@/components/not-found-page";
import { LegalConsentDialog } from "@/components/legal-consent-dialog";
import { AnalyticsConsent } from "@/components/analytics-consent";
import { ChangelogDialog } from "@/components/changelog-dialog";
import { Toaster } from "@/components/ui/sonner";
import { resolvedThemeAtom, themeClassEffect } from "@/atoms/theme";
import { localeDocumentEffect, localePreferenceEffect } from "@/atoms/locale";
import { isSignedInAtom, sessionSettledAtom, sessionSettledEffect } from "@/atoms/session";
import { useRequireHandle } from "@/hooks/use-require-handle";
import { useRequireSignedIn } from "@/hooks/use-require-signed-in";
import { fallbackHead } from "@/lib/document-head";

export const Route = createRootRoute({
  head: fallbackHead,
  component: RootLayout,
  // Rendered through this layout's own <Outlet/>, so an unmatched URL gets
  // the normal header/footer chrome instead of the router's bare default.
  notFoundComponent: NotFoundPage,
});

function RootLayout() {
  useEffect(() => {
    // index.html supplies metadata before the SPA can execute, so a cold load
    // is never an untitled document — and so no-JS crawlers still see unfurl
    // tags. HeadContent has committed the localized route metadata by the time
    // this effect runs; remove only those tagged fallbacks to leave a single
    // owner per tag afterward.
    document.querySelectorAll("[data-app-fallback]").forEach((el) => el.remove());
  }, []);

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
  const resolvedTheme = useAtomValue(resolvedThemeAtom);

  // While the first /get-session is in flight this renders nothing: the
  // splash is static markup in index.html (`#app-splash`), already painted
  // before the bundle loaded and removed by `sessionSettledEffect` the moment
  // the session lands. `<Outlet/>` not rendering means no route fires its
  // queries against a session that is about to change under it — this is the
  // fix for the signed-out flash on cold load, see sessionSettledAtom.
  if (!settled) return <HeadContent />;

  // The header renders only for a real session — never the Log in / Register
  // chrome. Signed-out visitors (on /login and friends) get a bare page; see
  // header.tsx, which narrows `viewerAtom` rather than branching on it.

  return (
    <>
      <HeadContent />
      <div className="bg-background text-foreground flex min-h-screen flex-col antialiased">
        {signedIn && <Header />}
        <main className="flex-1">
          <Outlet />
        </main>
        <Footer />
        <GlobalDialogs />
        {/* Mounted unconditionally: the dialog owns the whole decision — signed
            in, consent missing or stale, and not currently on one of the legal
            documents itself. Duplicating half of that here would let the two
            drift. */}
        <LegalConsentDialog />
        {/* Informational release notes yield to the mandatory legal gate, then
            remember dismissal per device. The dialog owns that decision. */}
        <ChangelogDialog />
        {/* This controller owns both the non-blocking consent banner and GA's
            lifecycle. With no build-time measurement id it renders nothing
            and performs no storage or network work. */}
        <AnalyticsConsent />
        {/* The app's toast surface (issue #307), mounted once like the root
            dialogs above. The generated wrapper reads next-themes for its
            theme default — an app this one doesn't use — so the theme the
            app actually enforces is passed as a prop; the wrapper spreads
            its props last, which is what makes that win. */}
        <Toaster theme={resolvedTheme} position="bottom-center" />
      </div>
    </>
  );
}
