import { useEffect } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { Check, KeyRound, Loader2 } from "lucide-react";
import { authPendingAtom } from "@/atoms/auth";
import {
  changePasswordAtom,
  confirmNewPasswordAtom,
  currentPasswordAtom,
  hasPasswordAtom,
  newPasswordAtom,
  passwordChangedAtom,
  resetPasswordChangeAtom,
} from "@/atoms/account";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Section } from "@/components/settings/section";
import { m } from "@/paraglide/messages.js";

/**
 * Changing the password — rendered only for accounts that have one.
 *
 * An OAuth-only sign-up has no `credential` account row, so every field here
 * would be unanswerable and the request could only fail. Hiding the section is
 * the honest response; showing it disabled, or showing it and letting the
 * server reject it, both amount to advertising something that does not exist
 * for this account. `hasPasswordAtom` reads the linked-accounts query the
 * section below already issues, so this costs nothing extra.
 */
export function PasswordSection() {
  const hasPassword = useAtomValue(hasPasswordAtom);
  const [current, setCurrent] = useAtom(currentPasswordAtom);
  const [next, setNext] = useAtom(newPasswordAtom);
  const [confirm, setConfirm] = useAtom(confirmNewPasswordAtom);
  const changed = useAtomValue(passwordChangedAtom);
  const isBusy = useAtomValue(authPendingAtom);

  const changePassword = useSetAtom(changePasswordAtom);
  const reset = useSetAtom(resetPasswordChangeAtom);
  useEffect(() => reset, [reset]);

  // `undefined` while the accounts query is in flight. Rendering nothing rather
  // than the form avoids showing a password form to an OAuth user for a beat
  // and then snatching it away.
  if (hasPassword !== true) return null;

  return (
    <Section
      title={m.settings_password_title()}
      description={m.settings_password_description()}
      icon={<KeyRound className="h-5 w-5" />}
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void changePassword();
        }}
      >
        <div className="space-y-2">
          <label
            htmlFor="current-password"
            className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
          >
            {m.auth_field_current_password()}
          </label>
          <Input
            id="current-password"
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            autoComplete="current-password"
            className="h-10 bg-background/50"
            required
          />
        </div>

        <div className="space-y-2">
          <label
            htmlFor="new-password"
            className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
          >
            {m.auth_field_new_password()}
          </label>
          <Input
            id="new-password"
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            autoComplete="new-password"
            className="h-10 bg-background/50"
            required
          />
        </div>

        <div className="space-y-2">
          <label
            htmlFor="confirm-new-password"
            className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
          >
            {m.auth_field_confirm_new_password()}
          </label>
          <Input
            id="confirm-new-password"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            className="h-10 bg-background/50"
            required
          />
        </div>

        {/* `role="status"` rather than `role="alert"`: this is a confirmation,
            and alert is for the failure banner the page already owns. */}
        {changed && (
          <p role="status" className="text-xs text-link">
            {m.settings_password_changed()}
          </p>
        )}

        <p className="text-xs text-muted-foreground">{m.settings_password_revoke_hint()}</p>

        <Button type="submit" size="sm" className="rounded-full gap-2" disabled={isBusy}>
          {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          {m.settings_password_submit()}
        </Button>
      </form>
    </Section>
  );
}
