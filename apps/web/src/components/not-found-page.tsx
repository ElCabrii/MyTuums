import { Link } from "@tanstack/react-router";
import { Home } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageCard } from "@/components/page-card";
import { useDocumentHead } from "@/hooks/use-document-head";
import { m } from "@/paraglide/messages.js";

/**
 * The router's `notFoundComponent`, rendered through the root layout's
 * `<Outlet/>` — so an unmatched URL keeps the header/footer chrome (see
 * `__root.tsx`) instead of the router's bare default.
 *
 * It is a signed-in surface in practice: a signed-out visitor on an unmatched
 * path is outside the signed-out allowlist (`isSignedOutPath`), so
 * `useRequireSignedIn` sends them to `/login?redirect=<path>` before this
 * ever renders.
 */
export function NotFoundPage() {
  useDocumentHead(m.notfound_title());

  return (
    <div className="container mx-auto max-w-md px-4 py-16">
      <PageCard className="space-y-4 text-center">
        <p className="text-primary text-5xl font-bold tracking-tight">404</p>
        <h1 className="text-xl font-bold tracking-tight">{m.notfound_title()}</h1>
        <p className="text-muted-foreground text-sm">{m.notfound_body()}</p>
        <Button nativeButton={false} render={<Link to="/" className="gap-1.5" />}>
          <Home className="h-4 w-4" />
          <span>{m.common_back_to_home()}</span>
        </Button>
      </PageCard>
    </div>
  );
}
