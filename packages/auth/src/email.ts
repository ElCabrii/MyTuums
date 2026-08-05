/**
 * The one place this package sends mail.
 *
 * Every email-bearing auth flow (two-factor OTP, address verification,
 * password reset) goes through `sendEmail`, so swapping Resend for something
 * else is a change to this file alone.
 *
 * Resend is used when `RESEND_API_KEY` is set. When it isn't:
 *
 * - in development and test the message is logged and the flow continues, so
 *   TOTP-based 2FA, sign-up and password reset are all fully usable on a clone
 *   with no email account at all;
 * - in production the send *throws*, because silently dropping a password-reset
 *   link is worse than the caller reporting that it couldn't be sent. The
 *   person then sees an error instead of watching an inbox that will never
 *   receive anything.
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
 * (dev/test) or a hard failure (production) — never silently dropped.
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
 * `apps/web/messages/` cannot reach the server — so the copy for these three
 * emails lives here, keyed the same two ways.
 *
 * The locale comes off the same `PARAGLIDE_LOCALE` cookie the web app sets
 * (CLAUDE.md §i18n: resolution is `["cookie", "globalVariable", "baseLocale"]`,
 * with no URL segment), which is also what `i18n.ts` hands the Better Auth i18n
 * plugin for error messages. One cookie decides the language of everything the
 * server produces.
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
