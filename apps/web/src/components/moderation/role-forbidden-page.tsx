import { ShieldX } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages.js";

/**
 * Rendered by the moderation route when the viewer's role is below
 * `moderator` — a "you can't" page, not a redirect, so a moderator poking at a
 * staff tab sees the gate instead of looping (same reasoning as
 * `useRequireRole`'s docblock).
 */
export function RoleForbiddenPage() {
  return (
    <div className="container max-w-md mx-auto px-4 py-16">
      <div className="rounded-3xl border border-border/50 bg-card/60 backdrop-blur-xl p-6 sm:p-8 shadow-2xl text-center space-y-4">
        <ShieldX className="mx-auto h-10 w-10 text-muted-foreground" />
        <h1 className="text-xl font-bold tracking-tight">{m.moderation_forbidden_title()}</h1>
        <p className="text-sm text-muted-foreground">{m.moderation_forbidden_body()}</p>
        <Button nativeButton={false} render={<Link to="/" className="gap-1.5" />}>
          {m.common_back_to_home()}
        </Button>
      </div>
    </div>
  );
}
