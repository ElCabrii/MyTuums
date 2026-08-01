# Politique de confidentialité

**Dernière mise à jour : 2 août 2026**

*(La version anglaise de ce document, disponible [ici](./privacy-policy.en.md), est une traduction de courtoisie. En cas de divergence, la présente version française fait foi.)*

MyTuums (le « Service ») est une application sociale non professionnelle et non lucrative, gérée par une seule personne physique (l'« éditeur », « nous »). Cette politique explique quelles données personnelles nous traitons lorsque vous utilisez le Service, pourquoi, combien de temps, et quels droits vous avez.

Cette politique doit être lue avec les [mentions légales](./mentions-legales.fr.md), qui identifient l'éditeur et l'hébergeur.

## 1. Responsable du traitement

Le responsable du traitement, au sens de l'article 4.7 du RGPD, est l'éditeur du Site identifié dans les [mentions légales](./mentions-legales.fr.md), joignable à contact@mytuums.com pour toute question relative à vos données.

Compte tenu de la taille et de la nature du traitement (application non professionnelle, non lucrative, gérée par une seule personne), aucun délégué à la protection des données (DPO) n'est désigné — ce n'est pas requis par le RGPD dans ce cas. Le contact ci-dessus fait office de point de contact unique.

## 2. Données que nous collectons

| Donnée | Origine | Pourquoi |
|---|---|---|
| Adresse e-mail | Fournie à l'inscription | Identifiant de compte, communications relatives au compte |
| Nom d'utilisateur (`username`) et nom affiché (`displayUsername`) | Fournis à l'inscription | Identification publique sur le Service |
| Nom / pseudonyme affiché (`name`) | Fourni à l'inscription | Affiché sur votre profil et vos publications |
| Mot de passe | Fourni à l'inscription | Authentification — **jamais stocké en clair**, uniquement sous forme de hachage cryptographique (BetterAuth / scrypt) |
| Photo de profil (`image`), si vous en ajoutez une | Fournie par vous | Affichage sur votre profil |
| Contenu que vous publiez (posts, réponses) | Fourni par vous | Fonctionnement du Service : ce sont des publications publiques |
| « J'aime » et abonnements (qui vous suivez, qui vous suit) | Générés par votre usage | Fonctionnement du Service (fils d'actualité, compteurs) |
| Adresse IP et user-agent au moment de la connexion | Collectés automatiquement | Sécurité de session, prévention des abus |
| Jeton de session (cookie) | Généré à la connexion | Vous garder connecté |
| Compteurs de limitation de débit (identifiant utilisateur ou IP, horodatage) | Générés automatiquement | Empêcher le spam et les abus (ex. : likes ou abonnements en masse) |

Nous ne collectons **aucune** donnée de paiement (le Service est gratuit), aucune donnée de géolocalisation précise, et n'utilisons aucun outil d'analyse d'audience ou de publicité tiers à ce jour.

**Contenu public par défaut :** comme sur la plupart des réseaux sociaux, vos publications, réponses, « j'aime » et abonnements sont visibles par les autres utilisateurs (et, pour le fil global, potentiellement par les visiteurs non connectés). Ne publiez pas d'information que vous ne souhaitez pas rendre publique.

## 3. Finalités et bases légales (article 6 du RGPD)

- **Création et gestion de votre compte, affichage de vos publications, likes et abonnements** — exécution du contrat qui vous lie au Service dès lors que vous créez un compte et l'utilisez (art. 6.1.b RGPD) : ce sont les fonctionnalités mêmes que vous demandez en vous inscrivant.
- **Adresse IP, user-agent, jetons de session, compteurs de limitation de débit** — intérêt légitime (art. 6.1.f RGPD) à sécuriser les comptes, détecter les usages frauduleux et empêcher les abus, avec un impact limité sur votre vie privée au regard de cet objectif.
- **Réponse aux réquisitions judiciaires, respect de nos obligations légales (ex. : retrait de contenu manifestement illicite)** — obligation légale (art. 6.1.c RGPD).

Nous ne pratiquons aucun profilage automatisé produisant des effets juridiques, ni de décision entièrement automatisée vous concernant.

## 4. Destinataires des données

Vos données ne sont **jamais vendues**. Elles ne sont partagées qu'avec :

- **Railway Corporation** (voir [mentions légales](./mentions-legales.fr.md)), notre seul sous-traitant technique, qui héberge la base de données et le serveur applicatif. Railway agit en tant que sous-traitant au sens de l'article 28 du RGPD, dans le cadre de son propre Data Processing Addendum ([railway.com/legal/dpa](https://railway.com/legal/dpa)).
- Les autorités compétentes, uniquement lorsque la loi nous y oblige.

Nous n'utilisons aucun outil d'analyse d'audience, de publicité ou de service d'envoi d'e-mails tiers à ce jour. Si cela change, cette politique sera mise à jour avant tout déploiement, et votre consentement sera recueilli lorsque la loi l'exige (notamment pour les cookies non essentiels).

## 5. Transferts internationaux

Le calcul et la base de données du Service sont hébergés dans la région européenne (UE) de Railway. Railway Corporation est néanmoins une société de droit américain : un accès résiduel depuis les États-Unis (support technique, infrastructure sous-jacente) ne peut être totalement exclu.

Ce transfert potentiel est encadré par les garanties prévues au Data Processing Addendum de Railway (clauses contractuelles types de la Commission européenne et/ou cadre de protection des données UE-États-Unis — *EU-U.S. Data Privacy Framework*), conformément au chapitre V du RGPD.

## 6. Cookies

Le Service utilise un unique cookie de session (émis par BetterAuth), strictement nécessaire pour vous maintenir connecté. Ce cookie est exempté de recueil du consentement au sens des lignes directrices de la CNIL sur les cookies, car il est indispensable à la fourniture du service que vous demandez expressément.

Aucun cookie de mesure d'audience, publicitaire ou de traçage tiers n'est utilisé à ce jour.

## 7. Durée de conservation

- **Données de compte** (e-mail, nom d'utilisateur, mot de passe, photo de profil) : conservées tant que votre compte existe.
- **Contenu** (publications, réponses, likes, abonnements) : conservé tant que votre compte existe ; supprimé avec votre compte (suppression en cascade au niveau de la base de données).
- **Suppression de compte** : sur demande à contact@mytuums.com, vos données sont effacées dans un délai de 30 jours, à l'exception d'éventuelles copies résiduelles dans les sauvegardes techniques, purgées dans un délai maximal de 90 jours.
- **Session (jeton, IP, user-agent)** : la session expire automatiquement après 7 jours d'inactivité, ou immédiatement à la déconnexion.
- **Compteurs de limitation de débit** : conservés uniquement le temps nécessaire à l'application de la règle concernée (quelques minutes à quelques heures selon le type d'action).

## 8. Sécurité

Les mots de passe sont hachés (jamais stockés en clair). Les communications avec le Service sont chiffrées (HTTPS/TLS). L'accès à la base de données est restreint à l'infrastructure applicative. Aucun système n'étant infaillible, nous ne pouvons garantir une sécurité absolue, mais nous nous engageons à vous notifier dans les meilleurs délais en cas de violation de données vous concernant susceptible d'engendrer un risque élevé pour vos droits, conformément à l'article 34 du RGPD.

## 9. Vos droits

Conformément au RGPD et à la loi Informatique et Libertés, vous disposez des droits suivants sur vos données :

- **Droit d'accès** — obtenir une copie des données que nous détenons sur vous.
- **Droit de rectification** — corriger des données inexactes.
- **Droit à l'effacement** — demander la suppression de votre compte et de vos données.
- **Droit à la limitation du traitement**, dans les cas prévus par la loi.
- **Droit à la portabilité** — recevoir vos données dans un format structuré et couramment utilisé.
- **Droit d'opposition**, pour les traitements fondés sur l'intérêt légitime (section 3).

Pour exercer l'un de ces droits, écrivez à contact@mytuums.com. Nous répondrons dans un délai d'un mois, conformément à l'article 12 du RGPD.

Vous disposez également du droit d'introduire une réclamation auprès de l'autorité de contrôle compétente, en France la **CNIL** :
3 Place de Fontenoy, TSA 80715, 75334 Paris Cedex 07 — [cnil.fr](https://www.cnil.fr).
Si vous résidez hors de France, vous pouvez contacter l'autorité de protection des données de votre pays de résidence.

## 10. Mineurs

Le Service est réservé aux personnes âgées de 15 ans ou plus (âge du consentement numérique en France, en application de l'article 8 du RGPD tel que transposé). Nous ne collectons pas sciemment de données concernant des personnes de moins de 15 ans. Si vous pensez qu'un compte a été créé par un mineur de moins de 15 ans, signalez-le à contact@mytuums.com ; il sera supprimé.

## 11. Cessation du Service

Le Service est un projet non lucratif géré par une seule personne. En cas d'arrêt définitif, nous nous efforcerons de vous prévenir avec un préavis raisonnable via le Site ou par e-mail, et de vous laisser la possibilité d'exporter ou de demander la suppression de vos données avant la fermeture effective.

## 12. Modifications de cette politique

Cette politique peut être mise à jour, notamment en cas d'évolution du Service ou de la réglementation. Toute modification substantielle vous sera signalée par un avis sur le Site ou par e-mail avant son entrée en vigueur. La date de « dernière mise à jour » en tête de ce document reflète la version en vigueur.

## 13. Contact

Pour toute question relative à cette politique ou à vos données : contact@mytuums.com.
