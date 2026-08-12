/**
 * The one place this package sends mail.
 *
 * Every email-bearing auth flow (two-factor OTP, address verification,
 * password reset) and every moderation notice (issue #38) goes through
 * `sendEmail`, so swapping Resend for something else is a change to this file
 * alone.
 *
 * Resend is used when `RESEND_API_KEY` is set. When it isn't:
 *
 * - in development and test the message is logged and the flow continues, so
 *   TOTP-based 2FA, sign-up and password reset are all fully usable on a clone
 *   with no email account at all;
 * - in production the send logs loudly — the mail is still silently dropped
 *   from the caller's point of view. Better Auth swallows `sendEmail`
 *   rejections and runs reset/verification sends in the background, so the
 *   HTTP response is success and the person sees no error, only an inbox that
 *   never receives anything.
 */
import { Resend } from "resend";
import { emailFrom, isProduction, resendApiKey } from "./env.js";

/**
 * Constructed lazily rather than at module scope so importing this package
 * never reaches for the network or the key — `packages/api`'s unit tests and
 * the Better Auth CLI both import the auth instance purely for its types.
 */
let resend: Resend | undefined;

function client(apiKey: string): Resend {
  resend ??= new Resend(apiKey);
  return resend;
}

/** One email to send: recipient address plus plain-text subject and body. */
export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
}

/**
 * Sends one email: through Resend when a key is configured, otherwise logged
 * (dev/test) or a loudly-logged refusal (production). Note the prod path's
 * throw does NOT surface to the user — Better Auth swallows send rejections
 * and runs reset/verification sends in the background, so the HTTP response
 * is success either way; the loud log is for operators.
 */
export async function sendEmail({ to, subject, text }: OutgoingEmail): Promise<void> {
  if (!resendApiKey) {
    if (isProduction) {
      throw new Error(
        `Refusing to drop an auth email to ${to} silently: RESEND_API_KEY is not set. ` +
          "Set it (and EMAIL_FROM to an address on a domain verified with Resend), " +
          "or disable the flows that send mail.",
      );
    }

    // Quiet under Vitest only. The integration suite signs up a fresh user per
    // test and `emailVerification.sendOnSignUp` fires on every one, which would
    // bury the actual test output. Development still logs — that console line
    // is how you click a verification or password-reset link without an email
    // account, and the E2E stack deliberately runs as `development` so its
    // server output keeps them too.
    if (process.env.NODE_ENV !== "test") {
      console.info(`\n[auth:email] to=${to}\n[auth:email] subject=${subject}\n${text}\n`);
    }
    return;
  }

  const { error } = await client(resendApiKey).emails.send({
    from: emailFrom,
    to,
    subject,
    text,
  });

  // The Resend SDK reports failures in the response body rather than by
  // rejecting, so an unchecked call would look like a successful send.
  if (error) {
    throw new Error(`Resend refused the message to ${to}: ${error.message}`);
  }
}

/**
 * The two locales the server-side email copy ships in.
 *
 * The app ships in English and French, and the message catalogue in
 * `apps/web/messages/` cannot reach the server — so the copy for the auth and
 * moderation emails lives here, keyed the same two ways.
 *
 * The locale comes off the same `PARAGLIDE_LOCALE` cookie the web app sets
 * (resolution is `["cookie", "globalVariable", "baseLocale"]`, with no URL
 * segment), which is also what `i18n.ts` hands the Better Auth i18n plugin for
 * error messages. One cookie decides the language of everything the server
 * produces.
 */
export type EmailLocale = "en" | "fr";

/** The email locale for this request: the PARAGLIDE_LOCALE cookie when it is exactly "fr", else the base locale. */
export function localeFromRequest(headers: Headers | undefined): EmailLocale {
  const cookie = headers?.get("cookie");
  if (!cookie) return "en";

  // Deliberately a loose match rather than a full cookie parse: the only
  // question is whether the value is exactly "fr", and anything else — absent,
  // malformed, or a locale that was removed from the catalogue — falls back to
  // the base locale rather than erroring.
  return /(?:^|;\s*)PARAGLIDE_LOCALE=fr(?:;|$)/.test(cookie) ? "fr" : "en";
}

/**
 * Human-readable labels for the four roles, per locale — the role-change
 * email translates the code the database stores. Unknown codes pass through
 * untranslated rather than erroring; the map must never throw.
 */
const ROLE_LABEL: Record<string, Record<EmailLocale, string> | undefined> = {
  user: { en: "user", fr: "utilisateur" },
  moderator: { en: "moderator", fr: "modérateur" },
  staff: { en: "staff", fr: "membre du staff" },
  admin: { en: "administrator", fr: "administrateur" },
};

/**
 * Formats a date for email copy — long date and short time in the email's own
 * locale, so a suspension email names the exact hour it lifts, not just the day.
 */
function formatDateTime(date: Date, locale: EmailLocale): string {
  return date.toLocaleString(locale === "fr" ? "fr-FR" : "en-US", {
    dateStyle: "long",
    timeStyle: "short",
  });
}

const copy = {
  otp: {
    en: (otp: string) => ({
      subject: "Your MyTuums verification code",
      text:
        `Your MyTuums verification code is ${otp}\n\n` +
        "It expires in a few minutes. If you didn't try to sign in, someone may " +
        "have your password — change it and turn on two-factor authentication.",
    }),
    fr: (otp: string) => ({
      subject: "Votre code de vérification MyTuums",
      text:
        `Votre code de vérification MyTuums est ${otp}\n\n` +
        "Il expire dans quelques minutes. Si vous n'avez pas tenté de vous " +
        "connecter, quelqu'un connaît peut-être votre mot de passe : changez-le " +
        "et activez la double authentification.",
    }),
  },
  verify: {
    en: (url: string) => ({
      subject: "Confirm your MyTuums email address",
      text: `Confirm your email address to finish setting up your account:\n\n${url}\n\nIf you didn't create a MyTuums account, ignore this message.`,
    }),
    fr: (url: string) => ({
      subject: "Confirmez votre adresse e-mail MyTuums",
      text: `Confirmez votre adresse e-mail pour terminer la création de votre compte :\n\n${url}\n\nSi vous n'avez pas créé de compte MyTuums, ignorez ce message.`,
    }),
  },
  reset: {
    en: (url: string) => ({
      subject: "Reset your MyTuums password",
      text: `Choose a new password using the link below:\n\n${url}\n\nIf you didn't ask to reset your password, ignore this message — your current password still works.`,
    }),
    fr: (url: string) => ({
      subject: "Réinitialisez votre mot de passe MyTuums",
      text: `Choisissez un nouveau mot de passe avec le lien ci-dessous :\n\n${url}\n\nSi vous n'avez pas demandé de réinitialisation, ignorez ce message : votre mot de passe actuel reste valable.`,
    }),
  },
  /**
   * The moderation notices (issue #38). Every builder takes an `appealUrl`
   * where a decision can be contested — the signed-out HMAC link — because a
   * suspended or banned account cannot sign in to see anything else.
   */
  moderation: {
    removal: {
      en: ({
        postText,
        reason,
        appealUrl,
      }: {
        postText: string;
        reason: string;
        appealUrl: string;
      }) => ({
        subject: "Your post was removed from MyTuums",
        text:
          `A moderator removed your post.\n\n` +
          `Reason: ${reason}\n\n` +
          `Your post:\n"${postText}"\n\n` +
          `If you believe this was a mistake, you can appeal the decision:\n${appealUrl}`,
      }),
      fr: ({
        postText,
        reason,
        appealUrl,
      }: {
        postText: string;
        reason: string;
        appealUrl: string;
      }) => ({
        subject: "Votre publication a été retirée de MyTuums",
        text:
          `Un modérateur a retiré votre publication.\n\n` +
          `Motif : ${reason}\n\n` +
          `Votre publication :\n« ${postText} »\n\n` +
          `Si vous pensez qu'il s'agit d'une erreur, vous pouvez faire appel de cette décision :\n${appealUrl}`,
      }),
    },
    restore: {
      en: () => ({
        subject: "Your post was restored",
        text: `Good news: a moderator restored your post. It is visible on MyTuums again.`,
      }),
      fr: () => ({
        subject: "Votre publication a été restaurée",
        text: `Bonne nouvelle : un modérateur a restauré votre publication. Elle est de nouveau visible sur MyTuums.`,
      }),
    },
    suspension: {
      en: ({
        reason,
        expiresAt,
        appealUrl,
      }: {
        reason: string;
        expiresAt: Date;
        appealUrl: string;
      }) => ({
        subject: "Your account was suspended",
        text:
          `Your MyTuums account has been suspended until ${formatDateTime(expiresAt, "en")}.\n\n` +
          `Reason: ${reason}\n\n` +
          `If you believe this was a mistake, you can appeal the decision:\n${appealUrl}`,
      }),
      fr: ({
        reason,
        expiresAt,
        appealUrl,
      }: {
        reason: string;
        expiresAt: Date;
        appealUrl: string;
      }) => ({
        subject: "Votre compte a été suspendu",
        text:
          `Votre compte MyTuums a été suspendu jusqu'au ${formatDateTime(expiresAt, "fr")}.\n\n` +
          `Motif : ${reason}\n\n` +
          `Si vous pensez qu'il s'agit d'une erreur, vous pouvez faire appel de cette décision :\n${appealUrl}`,
      }),
    },
    unsuspension: {
      en: () => ({
        subject: "Your account is active again",
        text: `Good news: the suspension on your MyTuums account has been lifted. You can sign in again.`,
      }),
      fr: () => ({
        subject: "Votre compte est de nouveau actif",
        text: `Bonne nouvelle : la suspension de votre compte MyTuums a été levée. Vous pouvez vous reconnecter.`,
      }),
    },
    ban: {
      en: ({ reason, appealUrl }: { reason: string; appealUrl: string }) => ({
        subject: "Your account was banned",
        text:
          `Your MyTuums account has been banned.\n\n` +
          `Reason: ${reason}\n\n` +
          `If you believe this was a mistake, you can appeal the decision:\n${appealUrl}`,
      }),
      fr: ({ reason, appealUrl }: { reason: string; appealUrl: string }) => ({
        subject: "Votre compte a été banni",
        text:
          `Votre compte MyTuums a été banni.\n\n` +
          `Motif : ${reason}\n\n` +
          `Si vous pensez qu'il s'agit d'une erreur, vous pouvez faire appel de cette décision :\n${appealUrl}`,
      }),
    },
    unban: {
      en: () => ({
        subject: "Your account is no longer banned",
        text: `Good news: the ban on your MyTuums account has been lifted. You can sign in again.`,
      }),
      fr: () => ({
        subject: "Votre compte n'est plus banni",
        text: `Bonne nouvelle : le bannissement de votre compte MyTuums a été levé. Vous pouvez vous reconnecter.`,
      }),
    },
    role: {
      en: ({ role, reason }: { role: string; reason?: string }) => ({
        subject: "Your MyTuums role changed",
        text:
          `Your role on MyTuums is now ${ROLE_LABEL[role]?.["en"] ?? role}.` +
          (reason ? `\n\nReason: ${reason}` : "") +
          `\n\nIf you didn't expect this change, contact the moderation team.`,
      }),
      fr: ({ role, reason }: { role: string; reason?: string }) => ({
        subject: "Votre rôle MyTuums a changé",
        text:
          `Votre rôle sur MyTuums est désormais ${ROLE_LABEL[role]?.["fr"] ?? role}.` +
          (reason ? `\n\nMotif : ${reason}` : "") +
          `\n\nSi vous n'attendiez pas ce changement, contactez l'équipe de modération.`,
      }),
    },
    caseResolution: {
      en: ({ outcome, note }: { outcome: "actioned" | "dismissed"; note?: string }) => ({
        subject: "Your report was reviewed",
        text:
          (outcome === "actioned"
            ? `The MyTuums moderation team acted on the content you reported. Thank you for flagging it.`
            : `The MyTuums moderation team reviewed the content you reported and decided no action was needed.`) +
          (note ? `\n\nModerator's note: ${note}` : "") +
          `\n\nThere is nothing else you need to do.`,
      }),
      fr: ({ outcome, note }: { outcome: "actioned" | "dismissed"; note?: string }) => ({
        subject: "Votre signalement a été examiné",
        text:
          (outcome === "actioned"
            ? `L'équipe de modération de MyTuums a pris des mesures concernant le contenu que vous avez signalé. Merci de l'avoir signalé.`
            : `L'équipe de modération de MyTuums a examiné le contenu que vous avez signalé et a décidé qu'aucune mesure n'était nécessaire.`) +
          (note ? `\n\nNote du modérateur : ${note}` : "") +
          `\n\nVous n'avez rien d'autre à faire.`,
      }),
    },
    resolution: {
      en: ({ outcome, note }: { outcome: "upheld" | "overturned"; note?: string }) => ({
        subject: "Your appeal was reviewed",
        text:
          (outcome === "overturned"
            ? `Good news: your appeal was reviewed and the original decision was reversed.`
            : `Your appeal was reviewed and the original decision stands.`) +
          (note ? `\n\nReviewer's note: ${note}` : "") +
          `\n\nThis review is final.`,
      }),
      fr: ({ outcome, note }: { outcome: "upheld" | "overturned"; note?: string }) => ({
        subject: "Votre appel a été examiné",
        text:
          (outcome === "overturned"
            ? `Bonne nouvelle : votre appel a été examiné et la décision initiale a été annulée.`
            : `Votre appel a été examiné et la décision initiale est maintenue.`) +
          (note ? `\n\nNote du modérateur : ${note}` : "") +
          `\n\nCette décision est définitive.`,
      }),
    },
  },
} as const;

/** Builds the two-factor OTP email copy for the given locale. */
export function otpEmail(otp: string, locale: EmailLocale): Omit<OutgoingEmail, "to"> {
  return copy.otp[locale](otp);
}

/** Builds the email-verification email copy for the given locale. */
export function verificationEmail(url: string, locale: EmailLocale): Omit<OutgoingEmail, "to"> {
  return copy.verify[locale](url);
}

/** Builds the password-reset email copy for the given locale. */
export function passwordResetEmail(url: string, locale: EmailLocale): Omit<OutgoingEmail, "to"> {
  return copy.reset[locale](url);
}

/** Builds the post-removal notice copy — quotes the post and links the appeal. */
export function moderationRemovalEmail(
  args: { postText: string; reason: string; appealUrl: string },
  locale: EmailLocale,
): Omit<OutgoingEmail, "to"> {
  return copy.moderation.removal[locale](args);
}

/** Builds the post-restored notice copy. */
export function moderationRestoreEmail(locale: EmailLocale): Omit<OutgoingEmail, "to"> {
  return copy.moderation.restore[locale]();
}

/** Builds the suspension notice copy — names the expiry time and links the appeal. */
export function moderationSuspensionEmail(
  args: { reason: string; expiresAt: Date; appealUrl: string },
  locale: EmailLocale,
): Omit<OutgoingEmail, "to"> {
  return copy.moderation.suspension[locale](args);
}

/** Builds the suspension-lifted notice copy. */
export function moderationUnsuspensionEmail(locale: EmailLocale): Omit<OutgoingEmail, "to"> {
  return copy.moderation.unsuspension[locale]();
}

/** Builds the ban notice copy — states the reason and links the appeal. */
export function moderationBanEmail(
  args: { reason: string; appealUrl: string },
  locale: EmailLocale,
): Omit<OutgoingEmail, "to"> {
  return copy.moderation.ban[locale](args);
}

/** Builds the ban-lifted notice copy. */
export function moderationUnbanEmail(locale: EmailLocale): Omit<OutgoingEmail, "to"> {
  return copy.moderation.unban[locale]();
}

/** Builds the role-change notice copy — the reason is optional (a setRole without one). */
export function moderationRoleEmail(
  args: { role: string; reason?: string },
  locale: EmailLocale,
): Omit<OutgoingEmail, "to"> {
  return copy.moderation.role[locale](args);
}

/** Builds the report-resolution notice for reporters — the case's outcome, not the appeal's. */
export function moderationCaseResolutionEmail(
  args: { outcome: "actioned" | "dismissed"; note?: string },
  locale: EmailLocale,
): Omit<OutgoingEmail, "to"> {
  return copy.moderation.caseResolution[locale](args);
}

/** Builds the appeal-review notice copy for the given outcome. */
export function moderationResolutionEmail(
  args: { outcome: "upheld" | "overturned"; note?: string },
  locale: EmailLocale,
): Omit<OutgoingEmail, "to"> {
  return copy.moderation.resolution[locale](args);
}
