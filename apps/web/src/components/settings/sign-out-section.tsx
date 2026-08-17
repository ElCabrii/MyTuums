import { useAtomValue } from "jotai";
import { Loader2, LogOut } from "lucide-react";
import { authPendingAtom } from "@/atoms/auth";
import { Button } from "@/components/ui/button";
import { useSignOut } from "@/hooks/use-sign-out";
import { m } from "@/paraglide/messages.js";

/**
 * The sign-out card at the bottom of `/settings/account`.
 */
export function SignOutSection() {
  const handleSignOut = useSignOut();
  const isBusy = useAtomValue(authPendingAtom);

  return (
    <section className="border-border/50 bg-card/60 flex items-center justify-between gap-4 rounded-3xl border p-6 backdrop-blur-xl">
      <div className="space-y-1">
        <h2 className="font-semibold">{m.auth_sign_out()}</h2>
        <p className="text-muted-foreground text-xs">{m.settings_sign_out_description()}</p>
      </div>
      <Button
        variant="destructive"
        size="sm"
        className="shrink-0 gap-2 rounded-full"
        disabled={isBusy}
        onClick={() => void handleSignOut()}
      >
        {isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />}
        <span>{m.auth_sign_out()}</span>
      </Button>
    </section>
  );
}
