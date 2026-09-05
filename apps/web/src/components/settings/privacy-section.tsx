import { useAtomValue, useSetAtom } from "jotai";
import { Lock } from "lucide-react";
import { authPendingAtom } from "@/atoms/auth";
import { saveIsPrivateAtom } from "@/atoms/account";
import { viewerAtom } from "@/atoms/session";
import { Section } from "@/components/settings/section";
import { Switch } from "@/components/ui/switch";
import { m } from "@/paraglide/messages.js";

/**
 * The account-privacy toggle (issue #328).
 *
 * Reads the stored flag off the session (null = public, like every other
 * additionalField) and writes it through `saveIsPrivateAtom` (`updateUser`).
 * The profile's locked branch reads the same flag off `byUsername`, so the
 * toggle flips the profile once that query is invalidated — no reload.
 */
export function PrivacySection() {
  const viewer = useAtomValue(viewerAtom);
  const isBusy = useAtomValue(authPendingAtom);
  const saveIsPrivate = useSetAtom(saveIsPrivateAtom);

  const isPrivate = viewer?.isPrivate ?? false;

  return (
    <Section
      title={m.settings_privacy_title()}
      description={m.settings_privacy_description()}
      icon={<Lock className="h-5 w-5" />}
    >
      <label className="flex cursor-pointer items-center justify-between gap-4">
        <span className="space-y-1">
          <span className="block text-sm font-medium">{m.settings_privacy_private_label()}</span>
          <span className="text-muted-foreground block text-xs">
            {m.settings_privacy_private_description()}
          </span>
        </span>
        <Switch
          checked={isPrivate}
          disabled={isBusy}
          aria-label={m.settings_privacy_private_label()}
          onCheckedChange={(checked) => {
            if (!isBusy) void saveIsPrivate(checked);
          }}
        />
      </label>
    </Section>
  );
}
