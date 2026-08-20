import { useEffect } from "react";
import { Link, useLocation } from "@tanstack/react-router";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  acceptLegalConsentAtom,
  legalConsentCheckboxAtom,
  legalConsentErrorAtom,
  legalConsentModeAtom,
  legalConsentPendingAtom,
  legalConsentRequiredAtom,
  resetLegalConsentAtom,
} from "@/atoms/legal-consent";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { m } from "@/paraglide/messages.js";

/**
 * The documents this gate asks the reader to accept.
 *
 * The gate never covers them. Its checkbox links open here in a new tab, and
 * the dialog cannot be dismissed — without this the new tab would land on
 * `/terms` and immediately paint the same modal over it, leaving no way to
 * read what is being accepted. `useLocation` is what re-runs the check on
 * navigation, the same reason `hooks/use-require-signed-in.ts` reads it.
 */
const LEGAL_DOCUMENT_PATHS = new Set(["/terms", "/privacy", "/mentions-legales"]);

/**
 * The app-wide legal consent gate. Mounted once in the root layout so any
 * signed-in page can be held behind the same dialog, including OAuth/passkey
 * accounts that never saw the registration checkbox.
 */
export function LegalConsentDialog() {
  const required = useAtomValue(legalConsentRequiredAtom);
  const mode = useAtomValue(legalConsentModeAtom);
  const pending = useAtomValue(legalConsentPendingAtom);
  const error = useAtomValue(legalConsentErrorAtom);
  const [accepted, setAccepted] = useAtom(legalConsentCheckboxAtom);
  const accept = useSetAtom(acceptLegalConsentAtom);
  const reset = useSetAtom(resetLegalConsentAtom);
  const { pathname } = useLocation();

  useEffect(() => reset, [reset]);

  if (!required || LEGAL_DOCUMENT_PATHS.has(pathname)) return null;

  return (
    <Dialog open={required}>
      <DialogContent showCloseButton={false} className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {mode === "missing" ? m.legal_consent_missing_title() : m.legal_consent_update_title()}
          </DialogTitle>
          <DialogDescription>
            {mode === "missing"
              ? m.legal_consent_missing_description()
              : m.legal_consent_update_description()}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 px-6 pb-6">
          <div className="flex items-start gap-3">
            <input
              id="legal-consent"
              type="checkbox"
              checked={accepted}
              onChange={(event) => setAccepted(event.target.checked)}
              aria-labelledby="legal-consent-label"
              className="mt-1"
            />
            {/*
              The same structure as the register form's box: the label covers
              only the leading text, and the two documents open in a new tab.
              Wrapping the links in the label would make "read the terms"
              toggle the box instead, and this dialog cannot be dismissed — an
              in-page navigation would leave the reader behind a modal with no
              way back to what it is asking them to accept.
            */}
            <span id="legal-consent-label" className="text-muted-foreground text-sm">
              <label htmlFor="legal-consent" className="cursor-pointer">
                {m.auth_register_terms_before()}
              </label>
              <Link
                to="/terms"
                target="_blank"
                rel="noopener noreferrer"
                className="text-link font-medium hover:underline"
              >
                {m.legal_terms_of_service()}
              </Link>
              {m.auth_register_terms_mid()}
              <Link
                to="/privacy"
                target="_blank"
                rel="noopener noreferrer"
                className="text-link font-medium hover:underline"
              >
                {m.legal_privacy_policy()}
              </Link>
              {m.auth_register_terms_after()}
            </span>
          </div>

          {error && (
            <p role="alert" className="text-destructive text-xs">
              {error}
            </p>
          )}

          <Button
            className="w-full"
            disabled={!accepted || pending}
            onClick={() => {
              void accept();
            }}
          >
            {pending ? m.legal_consent_accepting() : m.legal_consent_accept()}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
