import { createRootRoute, Outlet } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { Header } from "@/components/header";
import { Footer } from "@/components/footer";
import { themeClassEffect } from "@/atoms/theme";
import { localeDocumentEffect } from "@/atoms/locale";
import { useRequireHandle } from "@/hooks/use-require-handle";

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  // Mounts the theme side effect for the lifetime of the app — see
  // src/atoms/theme.ts. `atomEffect` atoms resolve to `void`; the value is
  // never used, only the subscription its `useAtomValue` establishes.
  useAtomValue(themeClassEffect);
  useAtomValue(localeDocumentEffect);

  // Here rather than per-route so no future route can forget it: an OAuth
  // sign-up with no handle yet is sent to /welcome from wherever it lands.
  useRequireHandle();

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
