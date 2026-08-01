import { getLocale } from "@/paraglide/runtime.js";
import { LegalDocument } from "@/components/legal/legal-document";
import { TermsOfServiceFr } from "@/components/legal/terms-of-service.fr";
import { TermsOfServiceEn } from "@/components/legal/terms-of-service.en";

/**
 * `getLocale()` is safe to read directly at render time (not through a
 * reactive atom): paraglide's `setLocale` — used by the footer's language
 * switcher — does a full page reload by default, so this component is never
 * expected to update in place after the locale changes.
 */
export function TermsOfService() {
  const locale = getLocale();

  return (
    <LegalDocument
      title={locale === "fr" ? "Conditions Générales d'Utilisation" : "Terms of Service"}
      updated={locale === "fr" ? "Dernière mise à jour : 2 août 2026" : "Last updated: August 2, 2026"}
    >
      {locale === "fr" ? <TermsOfServiceFr /> : <TermsOfServiceEn />}
    </LegalDocument>
  );
}
