import { Link } from "@tanstack/react-router";
import { Home } from "lucide-react";
import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages.js";

/**
 * The router's `notFoundComponent`, rendered through the root layout's
 * `<Outlet/>` — so an unmatched URL keeps the header/footer chrome (see
 * `__root.tsx`) instead of the router's bare default.
 *
 * It is a signed-in surface in practice: a signed-out visitor on an unmatched
 * path is not on the `ALLOWED_SIGNED_OUT` list, so `useRequireSignedIn` sends
 * them to `/login?redirect=<path>` before this ever renders.
 */
export function NotFoundPage() {
  return (
    <div className="container max-w-md mx-auto px-4 py-16">
      <div className="rounded-3xl border border-border/50 bg-card/60 backdrop-blur-xl p-6 sm:p-8 shadow-2xl text-center space-y-4">
        <p className="text-5xl font-bold tracking-tight text-primary">404</p>
        <h1 className="text-xl font-bold tracking-tight">{m.notfound_title()}</h1>
        <p className="text-sm text-muted-foreground">{m.notfound_body()}</p>
        <Button nativeButton={false} render={<Link to="/" className="gap-1.5" />}>
          <Home className="h-4 w-4" />
          <span>{m.common_back_to_home()}</span>
        </Button>
      </div>
    </div>
  );
}
