import { Link } from "@tanstack/react-router";
import { m } from "@/paraglide/messages.js";
import { LegalDocument } from "@/components/legal/legal-document";

/**
 * The LCEN legal notice, rendered in the current locale like the other
 * legal pages. The French text remains the legally authoritative filing;
 * English-speaking visitors get the English translation of the same
 * notice.
 */
export function MentionsLegales() {
  return (
    <LegalDocument title={m.legal_notice_title()} updated={m.legal_notice_updated()}>
      <h2>{m.legal_notice_s1_title()}</h2>
      <p>{m.legal_notice_s1_p1()}</p>
      <p>{m.legal_notice_s1_p2()}</p>
      <p>{m.legal_notice_s1_p3()}</p>
      <p>{m.legal_notice_s1_contact()}</p>

      <h2>{m.legal_notice_s2_title()}</h2>
      <p>{m.legal_notice_s2_p1()}</p>

      <h2>{m.legal_notice_s3_title()}</h2>
      <p>{m.legal_notice_s3_p1()}</p>
      <p>
        <strong>{m.legal_notice_s3_host_strong()}</strong>
        <br />
        {m.legal_notice_s3_host_street()}
        <br />
        {m.legal_notice_s3_host_city()}
        <br />
        {m.legal_notice_s3_host_country()}
        <br />
        {m.legal_notice_s3_host_contact()}
        <a href="https://railway.com">railway.com</a>
      </p>
      <p>
        {m.legal_notice_s3_p2_before()}
        <Link to="/privacy">{m.legal_privacy_policy()}</Link>
        {m.legal_notice_s3_p2_after()}
      </p>

      <h2>{m.legal_notice_s4_title()}</h2>
      <p>{m.legal_notice_s4_p1()}</p>
      <p>
        {m.legal_notice_s4_p2_before()}
        <Link to="/terms">{m.legal_terms_title()}</Link>
        {m.legal_notice_s4_p2_after()}
      </p>

      <h2>{m.legal_notice_s5_title()}</h2>
      <p>
        {m.legal_notice_s5_p1_before()}
        <Link to="/privacy">{m.legal_privacy_policy()}</Link>
        {m.legal_notice_s5_p1_after()}
      </p>

      <h2>{m.legal_notice_s6_title()}</h2>
      <p>{m.legal_notice_s6_p1()}</p>
      <p>{m.legal_notice_s6_p2()}</p>
      <p>
        {m.legal_notice_s6_p3_before()}
        <strong>{m.legal_notice_s6_p3_strong()}</strong>
        {m.legal_notice_s6_p3_after()}
        <a href="https://www.internet-signalement.gouv.fr">internet-signalement.gouv.fr</a>
      </p>

      <h2>{m.legal_notice_s7_title()}</h2>
      <p>{m.legal_notice_s7_p1()}</p>
    </LegalDocument>
  );
}
