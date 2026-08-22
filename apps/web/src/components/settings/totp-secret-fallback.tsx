import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { Check, Copy, KeyRound } from "lucide-react";
import {
  copyTwoFactorSecretAtom,
  twoFactorSecretCopiedAtom,
  twoFactorSecretShownAtom,
} from "@/atoms/two-factor";
import { Button } from "@/components/ui/button";
import { formatTotpSecret, totpSecretFrom } from "@/lib/totp";
import { m } from "@/paraglide/messages.js";

/**
 * The "Can't scan?" manual-entry fallback for TOTP enrolment (issue #169).
 *
 * Someone without a camera — a desktop authenticator, a managed device, or a
 * QR code that simply will not scan — cannot otherwise finish setup, because
 * the QR image is the only place the shared secret appears.
 *
 * One component used by both enrolment surfaces (the settings card and the
 * `/welcome` offer) so the two cannot drift, which is the same reason those
 * two already share the enrolment atoms.
 *
 * Collapsed by default and never rendered outside the active `verify` step:
 * the secret IS the second factor, so it should not sit on screen for the
 * majority who scanned the code. It lives only in `twoFactorSetupAtom` (in
 * memory, never persisted), is derived here rather than fetched, and is never
 * logged. Leaving or restarting enrolment re-collapses this and discards the
 * secret with it.
 */
export function TotpSecretFallback({ totpURI }: { totpURI: string }) {
  const [shown, setShown] = useAtom(twoFactorSecretShownAtom);
  const copied = useAtomValue(twoFactorSecretCopiedAtom);
  const copySecret = useSetAtom(copyTwoFactorSecretAtom);

  const secret = totpSecretFrom(totpURI);
  // A URI we cannot parse a secret out of would otherwise offer an empty key
  // to type in, which is worse than offering nothing.
  if (!secret) return null;

  return (
    <div className="space-y-2">
      {!shown && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="gap-2 rounded-full"
          onClick={() => setShown(true)}
        >
          <KeyRound className="h-3.5 w-3.5" />
          {m.twofa_cannot_scan()}
        </Button>
      )}

      {shown && (
        <div className="space-y-2">
          <p className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">
            {m.twofa_secret_key()}
          </p>
          <p className="text-muted-foreground text-xs">{m.twofa_secret_key_hint()}</p>
          {/* Grouped into blocks of four for readable manual entry; the copy
              action below copies the unformatted value, so nothing depends on
              the authenticator app stripping whitespace. */}
          <p className="bg-muted/40 rounded-2xl p-4 font-mono text-xs break-all select-all">
            {formatTotpSecret(secret)}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-2 rounded-full"
            onClick={() => void copySecret(secret)}
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? m.twofa_secret_copied() : m.twofa_copy_secret()}
          </Button>
        </div>
      )}
    </div>
  );
}
