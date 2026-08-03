import { useNavigate } from "@tanstack/react-router";
import { useAtomValue, useSetAtom } from "jotai";
import { Loader2, LogOut } from "lucide-react";
import { authPendingAtom, signOutAtom } from "@/atoms/auth";
import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages.js";

export function SignOutSection() {
  const navigate = useNavigate();
  const signOut = useSetAtom(signOutAtom);
  const isBusy = useAtomValue(authPendingAtom);

  return (
    <section className="rounded-3xl border border-border/50 bg-card/60 backdrop-blur-xl p-6 flex items-center justify-between gap-4">
      <div className="space-y-1">
        <h2 className="font-semibold">{m.auth_sign_out()}</h2>
        <p className="text-xs text-muted-foreground">{m.settings_sign_out_description()}</p>
      </div>
      <Button
        variant="destructive"
        size="sm"
        className="rounded-full gap-2 shrink-0"
        disabled={isBusy}
        onClick={() => {
          // `signOutAtom` waits for the session store to actually empty before
          // resolving (see lib/session-sync.ts), so this navigation cannot be
          // undone by a redirect effect reading a stale session.
          void signOut().then(() => navigate({ to: "/login" }));
        }}
      >
        {isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />}
        <span>{m.auth_sign_out()}</span>
      </Button>
    </section>
  );
}
