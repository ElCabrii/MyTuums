/**
 * French translations for Better Auth's own error messages.
 *
 * The web app's message catalogue (`apps/web/messages/{en,fr}.json`) can only
 * translate strings the *client* produces. Anything Better Auth rejects — a
 * wrong password, a taken username, an expired OTP — comes back as English
 * from the server, and `apps/web/src/lib/auth-error-message.ts` deliberately
 * **passes unrecognised errors straight through** rather than swallowing them
 * on a lookup miss. That pass-through is what makes this file worth having:
 * translate at the source and the existing client code needs no change at all.
 *
 * Only the codes a person can actually provoke are listed. Better Auth keeps
 * its English message for anything absent (see the plugin's fallback
 * behaviour), so an untranslated internal failure degrades to English rather
 * than to a bare code — and adding a translation later is additive.
 *
 * Codes come from Better Auth core plus the `username`, `two-factor`,
 * `haveIBeenPwned` and `passkey` plugins.
 */
import type { TranslationDictionary } from "@better-auth/i18n";

/** French translations of Better Auth's error messages, keyed by error code (file header explains the why). */
export const fr: TranslationDictionary = {
  // Credentials and sessions
  INVALID_EMAIL_OR_PASSWORD: "E-mail ou mot de passe incorrect.",
  INVALID_USERNAME_OR_PASSWORD: "Nom d'utilisateur ou mot de passe incorrect.",
  INVALID_PASSWORD: "Mot de passe incorrect.",
  INVALID_EMAIL: "Adresse e-mail invalide.",
  USER_NOT_FOUND: "Utilisateur introuvable.",
  ACCOUNT_NOT_FOUND: "Compte introuvable.",
  CREDENTIAL_ACCOUNT_NOT_FOUND:
    "Ce compte n'a pas de mot de passe : connectez-vous avec le service que vous avez utilisé à l'inscription.",
  SESSION_EXPIRED: "Session expirée. Reconnectez-vous pour effectuer cette action.",
  SESSION_NOT_FRESH:
    "Reconnectez-vous pour confirmer votre identité avant de modifier ce réglage.",
  EMAIL_NOT_VERIFIED: "Adresse e-mail non vérifiée.",
  EMAIL_ALREADY_VERIFIED: "Cette adresse e-mail est déjà vérifiée.",
  INVALID_TOKEN: "Lien invalide ou déjà utilisé.",
  TOKEN_EXPIRED: "Ce lien a expiré. Demandez-en un nouveau.",

  // Sign-up
  USER_ALREADY_EXISTS: "Un compte existe déjà avec ces informations.",
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL:
    "Un compte existe déjà avec cette adresse e-mail.",
  PASSWORD_TOO_SHORT: "Mot de passe trop court.",
  PASSWORD_TOO_LONG: "Mot de passe trop long.",
  PASSWORD_COMPROMISED:
    "Ce mot de passe figure dans une fuite de données connue. Choisissez-en un autre.",

  // Username plugin — the handle rules in ./index.ts
  INVALID_USERNAME:
    "Le nom d'utilisateur ne peut contenir que des lettres, chiffres, tirets et tirets bas.",
  INVALID_DISPLAY_USERNAME: "Nom d'affichage invalide.",
  USERNAME_IS_ALREADY_TAKEN: "Ce nom d'utilisateur est déjà pris. Essayez-en un autre.",
  USERNAME_TOO_SHORT: "Le nom d'utilisateur est trop court.",
  USERNAME_TOO_LONG: "Le nom d'utilisateur est trop long.",

  // Two-factor
  TWO_FACTOR_NOT_ENABLED: "La double authentification n'est pas activée.",
  TOTP_NOT_ENABLED: "L'application d'authentification n'est pas configurée.",
  OTP_NOT_ENABLED: "L'envoi de code par e-mail n'est pas activé.",
  INVALID_TWO_FACTOR_COOKIE:
    "Votre demande de connexion a expiré. Recommencez la connexion.",
  INVALID_OTP: "Code incorrect.",
  OTP_EXPIRED: "Ce code a expiré. Demandez-en un nouveau.",
  OTP_HAS_EXPIRED: "Ce code a expiré. Demandez-en un nouveau.",
  OTP_NOT_FOUND: "Aucun code en attente. Demandez-en un nouveau.",
  INVALID_BACKUP_CODE: "Code de secours incorrect ou déjà utilisé.",
  BACKUP_CODES_NOT_ENABLED: "Aucun code de secours n'a été généré.",
  ACCOUNT_TEMPORARILY_LOCKED:
    "Trop de tentatives échouées. Votre compte est temporairement bloqué, réessayez plus tard.",

  // Passkeys
  PASSKEY_NOT_FOUND: "Clé d'accès introuvable.",
  AUTHENTICATION_FAILED: "Échec de l'authentification.",
  AUTH_CANCELLED: "Connexion annulée.",
  REGISTRATION_CANCELLED: "Enregistrement annulé.",
  PREVIOUSLY_REGISTERED: "Cette clé d'accès est déjà enregistrée.",
  CHALLENGE_NOT_FOUND: "La demande a expiré. Réessayez.",
  FAILED_TO_VERIFY_REGISTRATION: "Impossible de vérifier cette clé d'accès.",
  FAILED_TO_UPDATE_PASSKEY: "Impossible de mettre à jour cette clé d'accès.",

  // Account linking
  SOCIAL_ACCOUNT_ALREADY_LINKED: "Ce compte est déjà lié à un autre utilisateur.",
  LINKED_ACCOUNT_ALREADY_EXISTS: "Ce compte est déjà lié.",
  FAILED_TO_UNLINK_LAST_ACCOUNT:
    "Impossible de délier votre dernière méthode de connexion.",
  PROVIDER_NOT_FOUND: "Ce service de connexion n'est pas disponible.",
  EMAIL_MISMATCH: "L'adresse e-mail ne correspond pas à celle du compte.",
};
