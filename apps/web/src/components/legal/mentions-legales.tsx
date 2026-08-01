import { Link } from "@tanstack/react-router";
import { LegalDocument } from "@/components/legal/legal-document";

/**
 * French-only by design: this is the mandatory LCEN "legal notice", a filing
 * addressed to French readers and authorities, not app copy — it doesn't get
 * a locale switch like the rest of the site.
 */
export function MentionsLegales() {
  return (
    <LegalDocument title="Mentions légales" updated="Dernière mise à jour : 2 août 2026">
      <em>
        English speakers: this page is the mandatory French "legal notice" required by law for
        any site published from France. It has no separate English version because it's a filing
        addressed to French readers and French authorities; the{" "}
        <Link to="/terms">Terms of Service</Link> and <Link to="/privacy">Privacy Policy</Link>{" "}
        are available in English.
      </em>

      <h2>1. Éditeur du site</h2>
      <p>
        Le site <strong>MyTuums</strong>, accessible à l'adresse mytuums.com (ci-après le «
        Site »), est édité par une personne physique agissant à titre non professionnel et sans
        but lucratif, au sens de l'article 1-1, II de la loi n° 2004-575 du 21 juin 2004 pour la
        confiance dans l'économie numérique (LCEN), dans sa rédaction issue de la loi n° 2024-449
        du 21 mai 2024 (loi SREN).
      </p>
      <p>
        Conformément à cette disposition, l'éditeur a choisi de préserver son anonymat vis-à-vis
        du public. Ses éléments d'identification complets (nom, prénom, domicile), tels
        qu'exigés à l'article 1-1, I, 1° de la LCEN pour un éditeur personne physique, ont été
        communiqués à son hébergeur mentionné à l'article 3 ci-dessous, qui les conserve.
      </p>
      <p>
        Ces données ne peuvent être divulguées qu'à l'autorité judiciaire, sur réquisition, dans
        les conditions prévues à l'article 6-II de la même loi. L'hébergeur est par ailleurs tenu
        au secret professionnel dans les conditions de l'article 226-13 du code pénal.
      </p>
      <p>Contact de l'éditeur : contact@mytuums.com</p>

      <h2>2. Directeur de la publication</h2>
      <p>
        Le directeur de la publication est l'éditeur mentionné à l'article 1 ci-dessus, dans les
        mêmes conditions d'anonymat prévues par la loi.
      </p>

      <h2>3. Hébergement</h2>
      <p>Le Site, y compris la base de données et le serveur applicatif, est hébergé par :</p>
      <p>
        <strong>Railway Corporation</strong>
        <br />
        548 Market St, PMB 68956
        <br />
        San Francisco, CA 94104
        <br />
        États-Unis
        <br />
        Contact : privacy@railway.com — <a href="https://railway.com">railway.com</a>
      </p>
      <p>
        Les traitements de données sont effectués sur l'infrastructure européenne (région UE) de
        cet hébergeur. Voir la <Link to="/privacy">Politique de confidentialité</Link>, section «
        Transferts internationaux », pour le détail des garanties applicables.
      </p>

      <h2>4. Propriété intellectuelle</h2>
      <p>
        La structure générale du Site, ainsi que les textes, graphismes, logos et éléments
        visuels qui lui sont propres (à l'exclusion des contenus publiés par les utilisateurs,
        voir ci-dessous) sont la propriété de l'éditeur ou font l'objet d'une autorisation
        d'utilisation, et sont protégés par le code de la propriété intellectuelle.
      </p>
      <p>
        Les contenus publiés par les utilisateurs (publications, réponses) restent la propriété
        de leurs auteurs respectifs, dans les conditions détaillées à l'article « Contenu publié
        par les utilisateurs » des <Link to="/terms">Conditions Générales d'Utilisation</Link>.
      </p>

      <h2>5. Données personnelles</h2>
      <p>
        Le traitement des données à caractère personnel des utilisateurs et visiteurs du Site
        est décrit en détail dans la <Link to="/privacy">Politique de confidentialité</Link>,
        conformément au règlement (UE) 2016/679 (RGPD) et à la loi n° 78-17 du 6 janvier 1978
        modifiée.
      </p>

      <h2>6. Signalement de contenu illicite</h2>
      <p>
        Tout utilisateur ou visiteur peut signaler un contenu qu'il estime illicite (haine,
        harcèlement, contenu terroriste, pédopornographique, contrefaisant, etc.) en écrivant à
        contact@mytuums.com, en décrivant précisément le contenu concerné et son emplacement
        (lien).
      </p>
      <p>
        Conformément à l'article 6-I-5 de la LCEN et à l'article 16 du règlement (UE) 2022/2065
        (Digital Services Act), toute notification suffisamment précise et motivée fera l'objet
        d'un examen et, le cas échéant, d'un retrait ou d'un blocage de l'accès dans les
        meilleurs délais.
      </p>
      <p>
        Pour les contenus manifestement les plus graves (apologie du terrorisme,
        pédopornographie), il est également possible de saisir directement la plateforme
        officielle de signalement du ministère de l'Intérieur :{" "}
        <strong>PHAROS</strong> —{" "}
        <a href="https://www.internet-signalement.gouv.fr">internet-signalement.gouv.fr</a>.
      </p>

      <h2>7. Droit applicable</h2>
      <p>Les présentes mentions légales sont soumises au droit français.</p>
    </LegalDocument>
  );
}
