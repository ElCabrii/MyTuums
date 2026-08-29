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
import { emailFrom, isProduction, resendApiKey, webOrigin } from "./env.js";

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

/** One multipart email to send: recipient, subject, HTML body and its plain-text fallback. */
export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * Sends one email: through Resend when a key is configured, otherwise logged
 * (dev/test) or a loudly-logged refusal (production). Note the prod path's
 * throw does NOT surface to the user — Better Auth swallows send rejections
 * and runs reset/verification sends in the background, so the HTTP response
 * is success either way; the loud log is for operators.
 */
export async function sendEmail({ to, subject, text, html }: OutgoingEmail): Promise<void> {
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
    html,
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

type EmailCopy = Pick<OutgoingEmail, "subject" | "text">;

const EMAIL_PRIMARY_COLOR = "#c6005c";
const EMAIL_TEXT_COLOR = "#2d282b";
const EMAIL_MUTED_COLOR = "#746b70";
const EMAIL_BORDER_COLOR = "#e7e0e4";
const EMAIL_BACKGROUND_COLOR = "#f6f3f5";
const EMAIL_FONT = "Arial,Helvetica,sans-serif";

type EmailAction = {
  url: string;
  label: string;
};

interface EmailRenderOptions {
  action?: EmailAction;
  otp?: string;
}

/**
 * The public logo asset, resolved against the same browser origin every
 * security-relevant email link uses. The server rejects a malformed origin at
 * boot; the fallback keeps this package's quiet env reader import-safe for CLI
 * tooling that may load it without the server validator.
 */
function emailLogoUrl(): string {
  try {
    return new URL("/mytuums-192.png", webOrigin).href;
  } catch {
    return "http://localhost:5173/mytuums-192.png";
  }
}

/** Escapes all copy before it enters the HTML part, including moderator-supplied reasons and notes. */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

type HtmlToken = {
  start: number;
  end: number;
  value: string;
  kind: "url" | "otp";
};

/** Turns non-action URLs into safe links and gives the OTP a quiet visual emphasis. */
function renderHtmlLine(line: string, otp?: string): string {
  const urlTokens: HtmlToken[] = [...line.matchAll(/https?:\/\/[^\s<>"']+/g)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    value: match[0],
    kind: "url",
  }));
  const tokens = [...urlTokens];

  if (otp) {
    let searchStart = 0;
    while (searchStart < line.length) {
      const start = line.indexOf(otp, searchStart);
      if (start === -1) break;

      const end = start + otp.length;
      const overlapsUrl = urlTokens.some((token) => start < token.end && end > token.start);
      if (!overlapsUrl) {
        tokens.push({ start, end, value: otp, kind: "otp" });
      }
      searchStart = end;
    }
  }

  tokens.sort((left, right) => left.start - right.start || right.end - left.end);

  let rendered = "";
  let previousEnd = 0;

  for (const token of tokens) {
    if (token.start < previousEnd) continue;

    rendered += escapeHtml(line.slice(previousEnd, token.start));
    if (token.kind === "otp") {
      rendered +=
        `<strong style="display:inline-block;padding:3px 9px;border:1px solid ${EMAIL_BORDER_COLOR};` +
        `border-radius:4px;background-color:#fbf4f7;color:${EMAIL_TEXT_COLOR};font-family:Courier New,Courier,monospace;` +
        `font-size:20px;font-weight:700;letter-spacing:3px;line-height:1.2;">${escapeHtml(token.value)}</strong>`;
    } else {
      rendered +=
        `<a href="${escapeHtml(token.value)}" ` +
        `style="color:${EMAIL_PRIMARY_COLOR};font-weight:600;text-decoration:underline;word-break:break-all;">` +
        `${escapeHtml(token.value)}</a>`;
    }
    previousEnd = token.end;
  }

  return rendered + escapeHtml(line.slice(previousEnd));
}

/**
 * Preserves the plain-text copy's paragraph structure while keeping the
 * primary action URL out of visible HTML. Other URLs in quoted content stay
 * safe and useful as ordinary text links.
 */
function renderHtmlCopy(text: string, options: EmailRenderOptions = {}): string {
  const actionUrl = options.action?.url;
  let actionRendered = false;

  return text
    .split(/\n{2,}/)
    .map((paragraph) => {
      const lines = paragraph.split("\n");
      const containsAction =
        !actionRendered &&
        actionUrl !== undefined &&
        lines.some((line) => line.trim() === actionUrl);
      const renderedLines = lines
        .filter((line) => line.trim().length > 0 && line.trim() !== actionUrl)
        .map((line) => renderHtmlLine(line, options.otp));

      if (containsAction) actionRendered = true;

      const renderedCopy =
        renderedLines.length === 0
          ? ""
          : `<p style="margin:0 0 18px;color:${EMAIL_TEXT_COLOR};font-family:${EMAIL_FONT};` +
            `font-size:15px;line-height:1.65;">${renderedLines.join("<br>")}</p>`;
      const renderedAction =
        containsAction && options.action ? renderActionButton(options.action) : "";

      return renderedCopy + renderedAction;
    })
    .filter(Boolean)
    .join("");
}

/** A table-backed button keeps the action dependable in Outlook and webmail. */
function renderActionButton(action: EmailAction): string {
  return (
    `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="border-collapse:separate;margin:4px 0 8px;">` +
    `<tr><td align="left" bgcolor="${EMAIL_PRIMARY_COLOR}" style="border-radius:5px;background-color:${EMAIL_PRIMARY_COLOR};">` +
    `<a href="${escapeHtml(action.url)}" ` +
    `style="display:inline-block;padding:12px 18px;border:1px solid ${EMAIL_PRIMARY_COLOR};border-radius:5px;` +
    `background-color:${EMAIL_PRIMARY_COLOR};color:#ffffff;font-family:${EMAIL_FONT};font-size:14px;` +
    `font-weight:700;line-height:1.2;text-decoration:none;">${escapeHtml(action.label)}</a>` +
    `</td></tr></table>`
  );
}

/**
 * Gives every auth and moderation message one branded HTML family while the
 * locale-specific copy remains the source of truth for both multipart parts.
 */
function brandedEmail(
  copy: EmailCopy,
  locale: EmailLocale,
  options: EmailRenderOptions = {},
): Omit<OutgoingEmail, "to"> {
  const subject = escapeHtml(copy.subject);
  const logoUrl = escapeHtml(emailLogoUrl());

  return {
    ...copy,
    html: `<!doctype html>
<html lang="${locale}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light">
    <meta name="supported-color-schemes" content="light">
    <title>${subject}</title>
  </head>
  <body style="margin:0;padding:0;background-color:${EMAIL_BACKGROUND_COLOR};color:${EMAIL_TEXT_COLOR};">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="${EMAIL_BACKGROUND_COLOR}" style="width:100%;border-collapse:collapse;background-color:${EMAIL_BACKGROUND_COLOR};">
      <tr>
        <td align="center" style="padding:24px 12px;">
          <table role="article" aria-labelledby="email-title" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#ffffff" style="width:100%;max-width:600px;border-collapse:separate;border-spacing:0;background-color:#ffffff;border:1px solid ${EMAIL_BORDER_COLOR};border-top:3px solid ${EMAIL_PRIMARY_COLOR};">
            <tr>
              <td style="padding:22px 32px 18px;border-bottom:1px solid ${EMAIL_BORDER_COLOR};">
                <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;">
                  <tr>
                    <td style="padding-right:10px;vertical-align:middle;">
                      <img src="${logoUrl}" width="32" height="32" alt="MyTuums logo" style="display:block;width:32px;height:32px;border:0;border-radius:7px;outline:none;text-decoration:none;">
                    </td>
                    <td style="color:${EMAIL_TEXT_COLOR};font-family:${EMAIL_FONT};font-size:17px;font-weight:700;letter-spacing:-0.2px;vertical-align:middle;">MyTuums</td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:30px 32px 26px;">
                <h1 id="email-title" style="margin:0 0 22px;color:${EMAIL_TEXT_COLOR};font-family:${EMAIL_FONT};font-size:24px;font-weight:700;line-height:1.25;">${subject}</h1>
                ${renderHtmlCopy(copy.text, options)}
              </td>
            </tr>
            <tr>
              <td style="padding:16px 32px 20px;border-top:1px solid ${EMAIL_BORDER_COLOR};color:${EMAIL_MUTED_COLOR};font-family:${EMAIL_FONT};font-size:12px;line-height:1.5;">MyTuums</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`,
  };
}

const ACTION_LABELS = {
  verify: {
    en: "Verify my email address",
    fr: "Vérifier mon adresse e-mail",
  },
  reset: {
    en: "Reset my password",
    fr: "Réinitialiser mon mot de passe",
  },
  appeal: {
    en: "Appeal this decision",
    fr: "Contester cette décision",
  },
} satisfies Record<"verify" | "reset" | "appeal", Record<EmailLocale, string>>;

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
const ROLE_LABEL = new Map<string, Record<EmailLocale, string>>([
  ["user", { en: "user", fr: "utilisateur" }],
  ["moderator", { en: "moderator", fr: "modérateur" }],
  ["staff", { en: "staff", fr: "membre du staff" }],
  ["admin", { en: "administrator", fr: "administrateur" }],
]);

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

/**
 * The "your post" block of a removal notice.
 *
 * An image-only post (issue #202) stores `content` as `""`, and quoting that
 * verbatim reads as an empty pair of quotes — the notice would then name
 * nothing the author could recognise the post by. So the quote block is
 * dropped entirely when there is no text and the attachments are counted
 * instead; a post carrying both gets the count alongside its quote.
 * "image"/"images" pluralizes identically in both locales, which is why the
 * count itself is built once rather than per-locale.
 */
function removedPostSummary(
  { postText, attachmentCount }: RemovalArgs,
  locale: EmailLocale,
): string {
  const images = attachmentCount === 1 ? "1 image" : `${attachmentCount} images`;
  const suffix = attachmentCount > 0 ? ` (${images})` : "";
  if (locale === "fr") {
    if (postText.length === 0) return `Votre publication : ${images}, sans texte.`;
    return `Votre publication${suffix} :\n« ${postText} »`;
  }
  if (postText.length === 0) return `Your post: ${images}, no text.`;
  return `Your post${suffix}:\n"${postText}"`;
}

/** What a removal notice is built from — the post it describes, plus the appeal link. */
interface RemovalArgs {
  postText: string;
  /** How many images the removed post carried; 0 for a text-only post. */
  attachmentCount: number;
  reason: string;
  appealUrl: string;
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
      en: (args: RemovalArgs) => ({
        subject: "Your post was removed from MyTuums",
        text:
          `A moderator removed your post.\n\n` +
          `Reason: ${args.reason}\n\n` +
          `${removedPostSummary(args, "en")}\n\n` +
          `If you believe this was a mistake, you can appeal the decision:\n${args.appealUrl}`,
      }),
      fr: (args: RemovalArgs) => ({
        subject: "Votre publication a été retirée de MyTuums",
        text:
          `Un modérateur a retiré votre publication.\n\n` +
          `Motif : ${args.reason}\n\n` +
          `${removedPostSummary(args, "fr")}\n\n` +
          `Si vous pensez qu'il s'agit d'une erreur, vous pouvez faire appel de cette décision :\n${args.appealUrl}`,
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
          `Your role on MyTuums is now ${ROLE_LABEL.get(role)?.en ?? role}.` +
          (reason ? `\n\nReason: ${reason}` : "") +
          `\n\nIf you didn't expect this change, contact the moderation team.`,
      }),
      fr: ({ role, reason }: { role: string; reason?: string }) => ({
        subject: "Votre rôle MyTuums a changé",
        text:
          `Votre rôle sur MyTuums est désormais ${ROLE_LABEL.get(role)?.fr ?? role}.` +
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
  return brandedEmail(copy.otp[locale](otp), locale, { otp });
}

/** Builds the email-verification email copy for the given locale. */
export function verificationEmail(url: string, locale: EmailLocale): Omit<OutgoingEmail, "to"> {
  return brandedEmail(copy.verify[locale](url), locale, {
    action: { url, label: ACTION_LABELS.verify[locale] },
  });
}

/** Builds the password-reset email copy for the given locale. */
export function passwordResetEmail(url: string, locale: EmailLocale): Omit<OutgoingEmail, "to"> {
  return brandedEmail(copy.reset[locale](url), locale, {
    action: { url, label: ACTION_LABELS.reset[locale] },
  });
}

/** Builds the post-removal notice copy — describes the post and links the appeal. */
export function moderationRemovalEmail(
  args: RemovalArgs,
  locale: EmailLocale,
): Omit<OutgoingEmail, "to"> {
  return brandedEmail(copy.moderation.removal[locale](args), locale, {
    action: { url: args.appealUrl, label: ACTION_LABELS.appeal[locale] },
  });
}

/** Builds the post-restored notice copy. */
export function moderationRestoreEmail(locale: EmailLocale): Omit<OutgoingEmail, "to"> {
  return brandedEmail(copy.moderation.restore[locale](), locale);
}

/** Builds the suspension notice copy — names the expiry time and links the appeal. */
export function moderationSuspensionEmail(
  args: { reason: string; expiresAt: Date; appealUrl: string },
  locale: EmailLocale,
): Omit<OutgoingEmail, "to"> {
  return brandedEmail(copy.moderation.suspension[locale](args), locale, {
    action: { url: args.appealUrl, label: ACTION_LABELS.appeal[locale] },
  });
}

/** Builds the suspension-lifted notice copy. */
export function moderationUnsuspensionEmail(locale: EmailLocale): Omit<OutgoingEmail, "to"> {
  return brandedEmail(copy.moderation.unsuspension[locale](), locale);
}

/** Builds the ban notice copy — states the reason and links the appeal. */
export function moderationBanEmail(
  args: { reason: string; appealUrl: string },
  locale: EmailLocale,
): Omit<OutgoingEmail, "to"> {
  return brandedEmail(copy.moderation.ban[locale](args), locale, {
    action: { url: args.appealUrl, label: ACTION_LABELS.appeal[locale] },
  });
}

/** Builds the ban-lifted notice copy. */
export function moderationUnbanEmail(locale: EmailLocale): Omit<OutgoingEmail, "to"> {
  return brandedEmail(copy.moderation.unban[locale](), locale);
}

/** Builds the role-change notice copy — the reason is optional (a setRole without one). */
export function moderationRoleEmail(
  args: { role: string; reason?: string },
  locale: EmailLocale,
): Omit<OutgoingEmail, "to"> {
  return brandedEmail(copy.moderation.role[locale](args), locale);
}

/** Builds the report-resolution notice for reporters — the case's outcome, not the appeal's. */
export function moderationCaseResolutionEmail(
  args: { outcome: "actioned" | "dismissed"; note?: string },
  locale: EmailLocale,
): Omit<OutgoingEmail, "to"> {
  return brandedEmail(copy.moderation.caseResolution[locale](args), locale);
}

/** Builds the appeal-review notice copy for the given outcome. */
export function moderationResolutionEmail(
  args: { outcome: "upheld" | "overturned"; note?: string },
  locale: EmailLocale,
): Omit<OutgoingEmail, "to"> {
  return brandedEmail(copy.moderation.resolution[locale](args), locale);
}
