import { createRootRoute, Outlet } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { Header } from "@/components/header";
import { Footer } from "@/components/footer";
import { themeClassEffect } from "@/atoms/theme";

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  // Mounts the theme side effect for the lifetime of the app — see
  // src/atoms/theme.ts. `atomEffect` atoms resolve to `void`; the value is
  // never used, only the subscription its `useAtomValue` establishes.
  useAtomValue(themeClassEffect);

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
