import { Link } from "@tanstack/react-router";

export function PrivacyPolicyFr() {
  return (
    <>
      <em>
        Ce document existe aussi en anglais — traduction de courtoisie, la présente version
        française faisant foi en cas de divergence. Changez de langue via le sélecteur du pied de
        page pour la consulter.
      </em>

      <p>
        MyTuums (le « Service ») est une application sociale non professionnelle et non
        lucrative, gérée par une seule personne physique (l'« éditeur », « nous »). Cette
        politique explique quelles données personnelles nous traitons lorsque vous utilisez le
        Service, pourquoi, combien de temps, et quels droits vous avez.
      </p>
      <p>
        Cette politique doit être lue avec les{" "}
        <Link to="/mentions-legales">mentions légales</Link>, qui identifient l'éditeur et
        l'hébergeur.
      </p>

      <h2>1. Responsable du traitement</h2>
      <p>
        Le responsable du traitement, au sens de l'article 4.7 du RGPD, est l'éditeur du Site
        identifié dans les <Link to="/mentions-legales">mentions légales</Link>, joignable à
        contact@mytuums.com pour toute question relative à vos données.
      </p>
      <p>
        Compte tenu de la taille et de la nature du traitement (application non professionnelle,
        non lucrative, gérée par une seule personne), aucun délégué à la protection des données
        (DPO) n'est désigné — ce n'est pas requis par le RGPD dans ce cas. Le contact ci-dessus
        fait office de point de contact unique.
      </p>

      <h2>2. Données que nous collectons</h2>
      <table>
        <thead>
          <tr>
            <th>Donnée</th>
            <th>Origine</th>
            <th>Pourquoi</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Adresse e-mail</td>
            <td>Fournie à l'inscription</td>
            <td>Identifiant de compte, communications relatives au compte</td>
          </tr>
          <tr>
            <td>Nom d'utilisateur et nom affiché</td>
            <td>Fournis à l'inscription</td>
            <td>Identification publique sur le Service</td>
          </tr>
          <tr>
            <td>Nom / pseudonyme affiché</td>
            <td>Fourni à l'inscription</td>
            <td>Affiché sur votre profil et vos publications</td>
          </tr>
          <tr>
            <td>Mot de passe</td>
            <td>Fourni à l'inscription</td>
            <td>
              Authentification — <strong>jamais stocké en clair</strong>, uniquement sous forme
              de hachage cryptographique (BetterAuth / scrypt)
            </td>
          </tr>
          <tr>
            <td>Photo de profil, si vous en ajoutez une</td>
            <td>Fournie par vous</td>
            <td>Affichage sur votre profil</td>
          </tr>
          <tr>
            <td>Contenu que vous publiez (posts, réponses)</td>
            <td>Fourni par vous</td>
            <td>Fonctionnement du Service : ce sont des publications publiques</td>
          </tr>
          <tr>
            <td>« J'aime » et abonnements</td>
            <td>Générés par votre usage</td>
            <td>Fonctionnement du Service (fils d'actualité, compteurs)</td>
          </tr>
          <tr>
            <td>Adresse IP et user-agent au moment de la connexion</td>
            <td>Collectés automatiquement</td>
            <td>Sécurité de session, prévention des abus</td>
          </tr>
          <tr>
            <td>Jeton de session (cookie)</td>
            <td>Généré à la connexion</td>
            <td>Vous garder connecté</td>
          </tr>
          <tr>
            <td>Compteurs de limitation de débit</td>
            <td>Générés automatiquement</td>
            <td>Empêcher le spam et les abus (ex. : likes ou abonnements en masse)</td>
          </tr>
        </tbody>
      </table>
      <p>
        Nous ne collectons <strong>aucune</strong> donnée de paiement (le Service est gratuit),
        aucune donnée de géolocalisation précise, et n'utilisons aucun outil d'analyse
        d'audience ou de publicité tiers à ce jour.
      </p>
      <p>
        <strong>Contenu public par défaut :</strong> comme sur la plupart des réseaux sociaux, vos
        publications, réponses, « j'aime » et abonnements sont visibles par les autres
        utilisateurs (et, pour le fil global, potentiellement par les visiteurs non connectés).
        Ne publiez pas d'information que vous ne souhaitez pas rendre publique.
      </p>

      <h2>3. Finalités et bases légales (article 6 du RGPD)</h2>
      <ul>
        <li>
          <strong>
            Création et gestion de votre compte, affichage de vos publications, likes et
            abonnements
          </strong>{" "}
          — exécution du contrat qui vous lie au Service dès lors que vous créez un compte et
          l'utilisez (art. 6.1.b RGPD) : ce sont les fonctionnalités mêmes que vous demandez en
          vous inscrivant.
        </li>
        <li>
          <strong>Adresse IP, user-agent, jetons de session, compteurs de limitation de débit</strong>{" "}
          — intérêt légitime (art. 6.1.f RGPD) à sécuriser les comptes, détecter les usages
          frauduleux et empêcher les abus, avec un impact limité sur votre vie privée au regard
          de cet objectif.
        </li>
        <li>
          <strong>
            Réponse aux réquisitions judiciaires, respect de nos obligations légales
          </strong>{" "}
          — obligation légale (art. 6.1.c RGPD).
        </li>
      </ul>
      <p>
        Nous ne pratiquons aucun profilage automatisé produisant des effets juridiques, ni de
        décision entièrement automatisée vous concernant.
      </p>

      <h2>4. Destinataires des données</h2>
      <p>
        Vos données ne sont <strong>jamais vendues</strong>. Elles ne sont partagées qu'avec :
      </p>
      <ul>
        <li>
          <strong>Railway Corporation</strong> (voir{" "}
          <Link to="/mentions-legales">mentions légales</Link>), notre seul sous-traitant
          technique, qui héberge la base de données et le serveur applicatif. Railway agit en
          tant que sous-traitant au sens de l'article 28 du RGPD, dans le cadre de son propre
          Data Processing Addendum (<a href="https://railway.com/legal/dpa">railway.com/legal/dpa</a>
          ).
        </li>
        <li>Les autorités compétentes, uniquement lorsque la loi nous y oblige.</li>
      </ul>
      <p>
        Nous n'utilisons aucun outil d'analyse d'audience, de publicité ou de service d'envoi
        d'e-mails tiers à ce jour. Si cela change, cette politique sera mise à jour avant tout
        déploiement, et votre consentement sera recueilli lorsque la loi l'exige (notamment pour
        les cookies non essentiels).
      </p>

      <h2>5. Transferts internationaux</h2>
      <p>
        Le calcul et la base de données du Service sont hébergés dans la région européenne (UE)
        de Railway. Railway Corporation est néanmoins une société de droit américain : un accès
        résiduel depuis les États-Unis (support technique, infrastructure sous-jacente) ne peut
        être totalement exclu.
      </p>
      <p>
        Ce transfert potentiel est encadré par les garanties prévues au Data Processing Addendum
        de Railway (clauses contractuelles types de la Commission européenne et/ou cadre de
        protection des données UE-États-Unis — <em>EU-U.S. Data Privacy Framework</em>),
        conformément au chapitre V du RGPD.
      </p>

      <h2>6. Cookies</h2>
      <p>
        Le Service utilise un unique cookie de session (émis par BetterAuth), strictement
        nécessaire pour vous maintenir connecté. Ce cookie est exempté de recueil du consentement
        au sens des lignes directrices de la CNIL sur les cookies, car il est indispensable à la
        fourniture du service que vous demandez expressément.
      </p>
      <p>
        Aucun cookie de mesure d'audience, publicitaire ou de traçage tiers n'est utilisé à ce
        jour.
      </p>

      <h2>7. Durée de conservation</h2>
      <ul>
        <li>
          <strong>Données de compte</strong> (e-mail, nom d'utilisateur, mot de passe, photo de
          profil) : conservées tant que votre compte existe.
        </li>
        <li>
          <strong>Contenu</strong> (publications, réponses, likes, abonnements) : conservé tant
          que votre compte existe ; supprimé avec votre compte (suppression en cascade au niveau
          de la base de données).
        </li>
        <li>
          <strong>Suppression de compte</strong> : sur demande à contact@mytuums.com, vos données
          sont effacées dans un délai de 30 jours, à l'exception d'éventuelles copies résiduelles
          dans les sauvegardes techniques, purgées dans un délai maximal de 90 jours.
        </li>
        <li>
          <strong>Session</strong> (jeton, IP, user-agent) : la session expire automatiquement
          après 7 jours d'inactivité, ou immédiatement à la déconnexion.
        </li>
        <li>
          <strong>Compteurs de limitation de débit</strong> : conservés uniquement le temps
          nécessaire à l'application de la règle concernée (quelques minutes à quelques heures
          selon le type d'action).
        </li>
      </ul>

      <h2>8. Sécurité</h2>
      <p>
        Les mots de passe sont hachés (jamais stockés en clair). Les communications avec le
        Service sont chiffrées (HTTPS/TLS). L'accès à la base de données est restreint à
        l'infrastructure applicative. Aucun système n'étant infaillible, nous ne pouvons
        garantir une sécurité absolue, mais nous nous engageons à vous notifier dans les
        meilleurs délais en cas de violation de données vous concernant susceptible d'engendrer
        un risque élevé pour vos droits, conformément à l'article 34 du RGPD.
      </p>

      <h2>9. Vos droits</h2>
      <p>
        Conformément au RGPD et à la loi Informatique et Libertés, vous disposez des droits
        suivants sur vos données :
      </p>
      <ul>
        <li>
          <strong>Droit d'accès</strong> — obtenir une copie des données que nous détenons sur
          vous.
        </li>
        <li>
          <strong>Droit de rectification</strong> — corriger des données inexactes.
        </li>
        <li>
          <strong>Droit à l'effacement</strong> — demander la suppression de votre compte et de
          vos données.
        </li>
        <li>
          <strong>Droit à la limitation du traitement</strong>, dans les cas prévus par la loi.
        </li>
        <li>
          <strong>Droit à la portabilité</strong> — recevoir vos données dans un format structuré
          et couramment utilisé.
        </li>
        <li>
          <strong>Droit d'opposition</strong>, pour les traitements fondés sur l'intérêt légitime
          (section 3).
        </li>
      </ul>
      <p>
        Pour exercer l'un de ces droits, écrivez à contact@mytuums.com. Nous répondrons dans un
        délai d'un mois, conformément à l'article 12 du RGPD.
      </p>
      <p>
        Vous disposez également du droit d'introduire une réclamation auprès de l'autorité de
        contrôle compétente, en France la <strong>CNIL</strong> : 3 Place de Fontenoy, TSA 80715,
        75334 Paris Cedex 07 — <a href="https://www.cnil.fr">cnil.fr</a>. Si vous résidez hors de
        France, vous pouvez contacter l'autorité de protection des données de votre pays de
        résidence.
      </p>

      <h2>10. Mineurs</h2>
      <p>
        Le Service est réservé aux personnes âgées de 15 ans ou plus (âge du consentement
        numérique en France, en application de l'article 8 du RGPD tel que transposé). Nous ne
        collectons pas sciemment de données concernant des personnes de moins de 15 ans. Si vous
        pensez qu'un compte a été créé par un mineur de moins de 15 ans, signalez-le à
        contact@mytuums.com ; il sera supprimé.
      </p>

      <h2>11. Cessation du Service</h2>
      <p>
        Le Service est un projet non lucratif géré par une seule personne. En cas d'arrêt
        définitif, nous nous efforcerons de vous prévenir avec un préavis raisonnable via le
        Site ou par e-mail, et de vous laisser la possibilité d'exporter ou de demander la
        suppression de vos données avant la fermeture effective.
      </p>

      <h2>12. Modifications de cette politique</h2>
      <p>
        Cette politique peut être mise à jour, notamment en cas d'évolution du Service ou de la
        réglementation. Toute modification substantielle vous sera signalée par un avis sur le
        Site ou par e-mail avant son entrée en vigueur. La date de « dernière mise à jour » en
        tête de ce document reflète la version en vigueur.
      </p>

      <h2>13. Contact</h2>
      <p>Pour toute question relative à cette politique ou à vos données : contact@mytuums.com.</p>
    </>
  );
}
