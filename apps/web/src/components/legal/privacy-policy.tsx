import { Link } from "@tanstack/react-router";
import { m } from "@/paraglide/messages.js";
import { LegalDocument } from "@/components/legal/legal-document";

/**
 * The privacy policy, rendered in the current locale. All prose lives in
 * the Paraglide catalogs (`messages/{en,fr}.json`) — this component is
 * locale-neutral by construction: the footer's language switcher performs
 * a full page reload, after which the active locale's text is shown.
 */
export function PrivacyPolicy() {
  return (
    <LegalDocument title={m.legal_privacy_title()} updated={m.legal_privacy_updated()}>
      <p>
        {m.legal_privacy_intro_p1_before()}
        <strong>{m.legal_privacy_intro_p1_strong()}</strong>
        {m.legal_privacy_intro_p1_after()}
      </p>
      <p>
        {m.legal_privacy_intro_p2_before()}
        <Link to="/mentions-legales">{m.legal_notice_link()}</Link>
        {m.legal_privacy_intro_p2_after()}
      </p>

      <h2>{m.legal_privacy_controller_title()}</h2>
      <p>
        {m.legal_privacy_controller_p1_before()}
        <Link to="/mentions-legales">{m.legal_notice_link()}</Link>
        {m.legal_privacy_controller_p1_after()}
      </p>
      <p>{m.legal_privacy_controller_p2()}</p>

      <h2>{m.legal_privacy_collected_title()}</h2>
      <table>
        <thead>
          <tr>
            <th>{m.legal_privacy_table_col_data()}</th>
            <th>{m.legal_privacy_table_col_source()}</th>
            <th>{m.legal_privacy_table_col_why()}</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>{m.legal_privacy_table_row_email_data()}</td>
            <td>{m.legal_privacy_table_row_email_source()}</td>
            <td>{m.legal_privacy_table_row_email_why()}</td>
          </tr>
          <tr>
            <td>{m.legal_privacy_table_row_username_data()}</td>
            <td>{m.legal_privacy_table_row_username_source()}</td>
            <td>{m.legal_privacy_table_row_username_why()}</td>
          </tr>
          <tr>
            <td>{m.legal_privacy_table_row_display_name_data()}</td>
            <td>{m.legal_privacy_table_row_display_name_source()}</td>
            <td>{m.legal_privacy_table_row_display_name_why()}</td>
          </tr>
          <tr>
            <td>{m.legal_privacy_table_row_dob_data()}</td>
            <td>{m.legal_privacy_table_row_dob_source()}</td>
            <td>{m.legal_privacy_table_row_dob_why()}</td>
          </tr>
          <tr>
            <td>{m.legal_privacy_table_row_password_data()}</td>
            <td>{m.legal_privacy_table_row_password_source()}</td>
            <td>
              {m.legal_privacy_table_row_password_why_before()}
              <strong>{m.legal_privacy_table_row_password_why_strong()}</strong>
              {m.legal_privacy_table_row_password_why_after()}
            </td>
          </tr>
          <tr>
            <td>{m.legal_privacy_table_row_photo_data()}</td>
            <td>{m.legal_privacy_table_row_photo_source()}</td>
            <td>{m.legal_privacy_table_row_photo_why()}</td>
          </tr>
          <tr>
            <td>{m.legal_privacy_table_row_content_data()}</td>
            <td>{m.legal_privacy_table_row_content_source()}</td>
            <td>{m.legal_privacy_table_row_content_why()}</td>
          </tr>
          <tr>
            <td>{m.legal_privacy_table_row_likes_data()}</td>
            <td>{m.legal_privacy_table_row_likes_source()}</td>
            <td>{m.legal_privacy_table_row_likes_why()}</td>
          </tr>
          <tr>
            <td>{m.legal_privacy_table_row_ip_data()}</td>
            <td>{m.legal_privacy_table_row_ip_source()}</td>
            <td>{m.legal_privacy_table_row_ip_why()}</td>
          </tr>
          <tr>
            <td>{m.legal_privacy_table_row_session_data()}</td>
            <td>{m.legal_privacy_table_row_session_source()}</td>
            <td>{m.legal_privacy_table_row_session_why()}</td>
          </tr>
          <tr>
            <td>{m.legal_privacy_table_row_rate_limit_data()}</td>
            <td>{m.legal_privacy_table_row_rate_limit_source()}</td>
            <td>{m.legal_privacy_table_row_rate_limit_why()}</td>
          </tr>
        </tbody>
      </table>
      <p>
        {m.legal_privacy_no_payment_before()}
        <strong>{m.legal_privacy_no_payment_strong()}</strong>
        {m.legal_privacy_no_payment_after()}
      </p>
      <p>
        <strong>{m.legal_privacy_public_default_strong()}</strong>
        {m.legal_privacy_public_default_after()}
      </p>

      <h2>{m.legal_privacy_bases_title()}</h2>
      <ul>
        <li>
          <strong>{m.legal_privacy_bases_li1_strong()}</strong>
          {m.legal_privacy_bases_li1_after()}
        </li>
        <li>
          <strong>{m.legal_privacy_bases_li2_strong()}</strong>
          {m.legal_privacy_bases_li2_after()}
        </li>
        <li>
          <strong>{m.legal_privacy_bases_li3_strong()}</strong>
          {m.legal_privacy_bases_li3_after()}
        </li>
      </ul>
      <p>{m.legal_privacy_bases_tail()}</p>

      <h2>{m.legal_privacy_sharing_title()}</h2>
      <p>
        {m.legal_privacy_sharing_p1_before()}
        <strong>{m.legal_privacy_sharing_p1_strong()}</strong>
        {m.legal_privacy_sharing_p1_after()}
      </p>
      <ul>
        <li>
          <strong>{m.legal_privacy_sharing_li1_strong()}</strong>
          {m.legal_privacy_sharing_li1_mid()}
          <Link to="/mentions-legales">{m.legal_notice_link()}</Link>
          {m.legal_privacy_sharing_li1_after()}
          <a href="https://railway.com/legal/dpa">railway.com/legal/dpa</a>
          {m.legal_privacy_sharing_li1_tail()}
        </li>
        <li>{m.legal_privacy_sharing_li2()}</li>
      </ul>
      <p>{m.legal_privacy_sharing_tail()}</p>

      <h2>{m.legal_privacy_transfers_title()}</h2>
      <p>{m.legal_privacy_transfers_p1()}</p>
      <p>{m.legal_privacy_transfers_p2()}</p>

      <h2>{m.legal_privacy_cookies_title()}</h2>
      <p>{m.legal_privacy_cookies_p1()}</p>
      <p>{m.legal_privacy_cookies_p2()}</p>

      <h2>{m.legal_privacy_retention_title()}</h2>
      <ul>
        <li>
          <strong>{m.legal_privacy_retention_li1_strong()}</strong>
          {m.legal_privacy_retention_li1_after()}
        </li>
        <li>
          <strong>{m.legal_privacy_retention_li2_strong()}</strong>
          {m.legal_privacy_retention_li2_after()}
        </li>
        <li>
          <strong>{m.legal_privacy_retention_li3_strong()}</strong>
          {m.legal_privacy_retention_li3_after()}
        </li>
        <li>
          <strong>{m.legal_privacy_retention_li4_strong()}</strong>
          {m.legal_privacy_retention_li4_after()}
        </li>
        <li>
          <strong>{m.legal_privacy_retention_li5_strong()}</strong>
          {m.legal_privacy_retention_li5_after()}
        </li>
      </ul>

      <h2>{m.legal_privacy_security_title()}</h2>
      <p>{m.legal_privacy_security_p1()}</p>

      <h2>{m.legal_privacy_rights_title()}</h2>
      <p>{m.legal_privacy_rights_p1()}</p>
      <ul>
        <li>
          <strong>{m.legal_privacy_rights_li1_strong()}</strong>
          {m.legal_privacy_rights_li1_after()}
        </li>
        <li>
          <strong>{m.legal_privacy_rights_li2_strong()}</strong>
          {m.legal_privacy_rights_li2_after()}
        </li>
        <li>
          <strong>{m.legal_privacy_rights_li3_strong()}</strong>
          {m.legal_privacy_rights_li3_after()}
        </li>
        <li>
          <strong>{m.legal_privacy_rights_li4_strong()}</strong>
          {m.legal_privacy_rights_li4_after()}
        </li>
        <li>
          <strong>{m.legal_privacy_rights_li5_strong()}</strong>
          {m.legal_privacy_rights_li5_after()}
        </li>
        <li>
          <strong>{m.legal_privacy_rights_li6_strong()}</strong>
          {m.legal_privacy_rights_li6_after()}
        </li>
      </ul>
      <p>{m.legal_privacy_rights_respond()}</p>
      <p>
        {m.legal_privacy_rights_cnil_before()}
        <strong>{m.legal_privacy_rights_cnil_strong()}</strong>
        {m.legal_privacy_rights_cnil_mid()}
        <a href="https://www.cnil.fr">cnil.fr</a>
        {m.legal_privacy_rights_cnil_after()}
      </p>

      <h2>{m.legal_privacy_minors_title()}</h2>
      <p>{m.legal_privacy_minors_p1()}</p>

      <h2>{m.legal_privacy_shutdown_title()}</h2>
      <p>{m.legal_privacy_shutdown_p1()}</p>

      <h2>{m.legal_privacy_changes_title()}</h2>
      <p>{m.legal_privacy_changes_p1()}</p>

      <h2>{m.legal_privacy_contact_title()}</h2>
      <p>{m.legal_privacy_contact_p1()}</p>
    </LegalDocument>
  );
}
