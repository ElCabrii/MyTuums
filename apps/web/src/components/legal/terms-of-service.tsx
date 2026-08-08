import { Link } from "@tanstack/react-router";
import { m } from "@/paraglide/messages.js";
import { LegalDocument } from "@/components/legal/legal-document";

/**
 * The terms of service, rendered in the current locale. All prose lives in
 * the Paraglide catalogs (`messages/{en,fr}.json`) — this component is
 * locale-neutral by construction: the footer's language switcher performs
 * a full page reload, after which the active locale's text is shown.
 */
export function TermsOfService() {
  return (
    <LegalDocument title={m.legal_terms_title()} updated={m.legal_terms_updated()}>
      <p>
        {m.legal_terms_intro_before()}
        <Link to="/mentions-legales">{m.legal_notice_link()}</Link>
        {m.legal_terms_intro_mid()}
        <Link to="/privacy">{m.legal_privacy_policy()}</Link>
        {m.legal_terms_intro_after()}
      </p>

      <h2>{m.legal_terms_nature_title()}</h2>
      <p>{m.legal_terms_nature_p1()}</p>
      <p>{m.legal_terms_nature_p2()}</p>

      <h2>{m.legal_terms_eligibility_title()}</h2>
      <p>
        {m.legal_terms_eligibility_before()}
        <strong>{m.legal_terms_eligibility_strong()}</strong>
        {m.legal_terms_eligibility_after()}
      </p>

      <h2>{m.legal_terms_account_title()}</h2>
      <p>{m.legal_terms_account_p1()}</p>

      <h2>{m.legal_terms_content_title()}</h2>
      <p>
        {m.legal_terms_content_p1_before()}
        <Link to="/privacy">{m.legal_privacy_policy()}</Link>
        {m.legal_terms_content_p1_after()}
      </p>
      <p>{m.legal_terms_content_p2()}</p>

      <h2>{m.legal_terms_use_title()}</h2>
      <p>{m.legal_terms_use_intro()}</p>
      <ul>
        <li>{m.legal_terms_use_li1()}</li>
        <li>{m.legal_terms_use_li2()}</li>
        <li>{m.legal_terms_use_li3()}</li>
        <li>{m.legal_terms_use_li4()}</li>
        <li>{m.legal_terms_use_li5()}</li>
      </ul>
      <p>{m.legal_terms_use_tail()}</p>

      <h2>{m.legal_terms_moderation_title()}</h2>
      <p>
        {m.legal_terms_moderation_p1_before()}
        <Link to="/mentions-legales">{m.legal_notice_link()}</Link>
        {m.legal_terms_moderation_p1_after()}
      </p>
      <p>{m.legal_terms_moderation_p2()}</p>

      <h2>{m.legal_terms_ip_title()}</h2>
      <p>{m.legal_terms_ip_p1()}</p>

      <h2>{m.legal_terms_warranty_title()}</h2>
      <p>{m.legal_terms_warranty_p1()}</p>

      <h2>{m.legal_terms_liability_title()}</h2>
      <p>{m.legal_terms_liability_p1()}</p>
      <p>
        <strong>{m.legal_terms_liability_p2_strong()}</strong>
        {m.legal_terms_liability_p2_after()}
      </p>

      <h2>{m.legal_terms_availability_title()}</h2>
      <p>
        {m.legal_terms_availability_p1_before()}
        <Link to="/privacy">{m.legal_privacy_policy()}</Link>
        {m.legal_terms_availability_p1_after()}
      </p>

      <h2>{m.legal_terms_termination_title()}</h2>
      <p>{m.legal_terms_termination_p1()}</p>
      <p>
        {m.legal_terms_termination_p2_before()}
        <Link to="/privacy">{m.legal_privacy_policy()}</Link>
        {m.legal_terms_termination_p2_after()}
      </p>

      <h2>{m.legal_terms_governing_title()}</h2>
      <p>{m.legal_terms_governing_p1()}</p>

      <h2>{m.legal_terms_changes_title()}</h2>
      <p>{m.legal_terms_changes_p1()}</p>

      <h2>{m.legal_terms_misc_title()}</h2>
      <p>{m.legal_terms_misc_p1()}</p>

      <h2>{m.legal_terms_contact_title()}</h2>
      <p>{m.legal_terms_contact_p1()}</p>
    </LegalDocument>
  );
}
