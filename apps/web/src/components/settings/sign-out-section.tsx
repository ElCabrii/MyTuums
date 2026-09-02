import { useAtomValue } from "jotai";
import { Loader2, LogOut } from "lucide-react";
import { authPendingAtom } from "@/atoms/auth";
import { Button } from "@/components/ui/button";
import { Section } from "@/components/settings/section";
import { useSignOut } from "@/hooks/use-sign-out";
import { m } from "@/paraglide/messages.js";

/**
 * The sign-out card closing the Account group of `/settings/account`.
 *
 * Issue #282 partially reverts #217: the settings page is a deliberate place
 * to end a session after reviewing it, while the profile page no longer
 * carries its own button — the navbar account menu (`header.tsx`) is the
 * always-visible affordance, and this card is the considered one. Both call
 * the same `useSignOut`, so a failure surfaces through `authErrorAtom` in
 * the page's shared error banner, and success lands on /login either way.
 */
export function SignOutSection() {
  const handleSignOut = useSignOut();
  const isBusy = useAtomValue(authPendingAtom);

  return (
    <Section
      title={m.auth_sign_out()}
      description={m.settings_sign_out_description()}
      icon={<LogOut className="h-5 w-5" />}
    >
      <Button
        variant="destructive"
        size="sm"
        className="shrink-0 gap-2 rounded-full"
        disabled={isBusy}
        onClick={() => void handleSignOut()}
      >
        {isBusy ? (
          <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
        ) : (
          <LogOut className="h-4 w-4" />
        )}
        <span>{m.auth_sign_out()}</span>
      </Button>
    </Section>
  );
}
