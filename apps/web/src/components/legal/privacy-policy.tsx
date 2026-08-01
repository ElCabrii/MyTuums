import { getLocale } from "@/paraglide/runtime.js";
import { LegalDocument } from "@/components/legal/legal-document";
import { PrivacyPolicyFr } from "@/components/legal/privacy-policy.fr";
import { PrivacyPolicyEn } from "@/components/legal/privacy-policy.en";

/**
 * `getLocale()` is safe to read directly at render time (not through a
 * reactive atom): paraglide's `setLocale` — used by the footer's language
 * switcher — does a full page reload by default, so this component is never
 * expected to update in place after the locale changes.
 */
export function PrivacyPolicy() {
  const locale = getLocale();

  return (
    <LegalDocument
      title={locale === "fr" ? "Politique de confidentialité" : "Privacy Policy"}
      updated={locale === "fr" ? "Dernière mise à jour : 2 août 2026" : "Last updated: August 2, 2026"}
    >
      {locale === "fr" ? <PrivacyPolicyFr /> : <PrivacyPolicyEn />}
    </LegalDocument>
  );
}
