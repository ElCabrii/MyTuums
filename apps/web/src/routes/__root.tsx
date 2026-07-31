import { createRootRoute, Outlet } from "@tanstack/react-router";
import { Header } from "@/components/header";
import { Footer } from "@/components/footer";

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
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
