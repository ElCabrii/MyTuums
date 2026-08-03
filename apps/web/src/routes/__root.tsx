import { createRootRoute, Outlet } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { Header } from "@/components/header";
import { Footer } from "@/components/footer";
import { themeClassEffect } from "@/atoms/theme";
import { localeDocumentEffect, localePreferenceEffect } from "@/atoms/locale";
import { useRequireHandle } from "@/hooks/use-require-handle";
import { useRequireSignedIn } from "@/hooks/use-require-signed-in";

export const Route = createRootRoute({
  component: RootLayout,
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

  // Here rather than per-route so no future route can forget it: an OAuth
  // sign-up with no handle yet is sent to /welcome from wherever it lands.
  useRequireHandle();

  // The site is private — a signed-out visitor on any non-auth page is sent
  // to /login with their destination preserved in ?redirect=.
  useRequireSignedIn();

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground antialiased">
      <Header />
      <main className="flex-1">
        <Outlet />
      </main>
      <Footer />
    </div>
  );
}
