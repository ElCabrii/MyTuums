import { useAtomValue, useSetAtom } from "jotai";
import { Link2 } from "lucide-react";
import { authPendingAtom } from "@/atoms/auth";
import {
  linkProviderAtom,
  linkedAccountsAtom,
  unlinkProviderAtom,
} from "@/atoms/linked-accounts";
import { socialProviders } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Section } from "@/components/settings/section";
import { m } from "@/paraglide/messages.js";

/**
 * The settings card for linking and unlinking social providers — the last
 * remaining sign-in method is protected from being unlinked (mirrors the
 * server's FAILED_TO_UNLINK_LAST_ACCOUNT).
 */
export function LinkedAccountsSection() {
  const { data: accounts, isPending } = useAtomValue(linkedAccountsAtom);
  const linkProvider = useSetAtom(linkProviderAtom);
  const unlinkProvider = useSetAtom(unlinkProviderAtom);
  const isBusy = useAtomValue(authPendingAtom);

  if (socialProviders.length === 0) return null;

  const linked = accounts ?? [];
  // Unlinking the only sign-in method would lock the account out. The server
  // refuses it too (FAILED_TO_UNLINK_LAST_ACCOUNT); this just means the button
  // is disabled rather than the error arriving after the click.
  const isLastMethod = linked.length <= 1;

  return (
    <Section
      title={m.settings_linked_title()}
      description={m.settings_linked_description()}
      icon={<Link2 className="h-5 w-5" />}
    >
      {isPending ? (
        <p className="text-xs text-muted-foreground">{m.settings_linked_loading()}</p>
      ) : (
        <ul className="space-y-2">
          {socialProviders.map((provider) => {
            const account = linked.find((a) => a.providerId === provider.id);
            return (
              <li
                key={provider.id}
                className="flex items-center gap-2 rounded-2xl border border-border/50 bg-background/40 px-4 py-2.5"
              >
                <span className="flex-1 text-sm">{provider.label}</span>
                {account ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-xs text-destructive"
                    disabled={isBusy || isLastMethod}
                    title={isLastMethod ? m.settings_linked_last_method() : undefined}
                    onClick={() =>
                      void unlinkProvider({
                        providerId: account.providerId,
                        accountId: account.accountId,
                      })
                    }
                  >
                    {m.settings_linked_unlink()}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-xs"
                    disabled={isBusy}
                    onClick={() => void linkProvider(provider.id)}
                  >
                    {m.settings_linked_link()}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
