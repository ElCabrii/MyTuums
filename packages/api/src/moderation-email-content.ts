import { z } from "zod";
import {
  moderationBanEmail,
  moderationCaseResolutionEmail,
  moderationRemovalEmail,
  moderationResolutionEmail,
  moderationRestoreEmail,
  moderationRoleEmail,
  moderationSuspensionEmail,
  moderationUnbanEmail,
  moderationUnsuspensionEmail,
  type EmailLocale,
  type OutgoingEmail,
} from "@my-tuums/auth/email";

/** Serializable notice content captured by the moderation transaction. */
export const moderationEmailContent = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("post_removed"),
    postText: z.string(),
    attachmentCount: z.number().int().nonnegative(),
    reason: z.string(),
  }),
  z.object({ kind: z.literal("post_restored") }),
  z.object({
    kind: z.literal("user_suspended"),
    reason: z.string(),
    expiresAt: z.number().int().positive(),
  }),
  z.object({ kind: z.literal("user_banned"), reason: z.string() }),
  z.object({ kind: z.literal("user_unbanned") }),
  z.object({ kind: z.literal("user_unsuspended") }),
  z.object({ kind: z.literal("role_changed"), role: z.string(), reason: z.string().nullable() }),
  z.object({
    kind: z.literal("case_resolved"),
    outcome: z.enum(["actioned", "dismissed"]),
    note: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("appeal_resolved"),
    outcome: z.enum(["upheld", "overturned"]),
    note: z.string().nullable(),
  }),
]);

export type ModerationEmailContent = z.infer<typeof moderationEmailContent>;

/** Recovery and immediate delivery render the same committed snapshot. */
export async function renderModerationEmail(
  content: ModerationEmailContent,
  context: {
    webOrigin: string;
    locale: EmailLocale;
    appealUrl(): Promise<string>;
  },
): Promise<Omit<OutgoingEmail, "to">> {
  const { webOrigin, locale } = context;
  switch (content.kind) {
    case "post_removed":
      return moderationRemovalEmail(
        webOrigin,
        {
          postText: content.postText,
          attachmentCount: content.attachmentCount,
          reason: content.reason,
          appealUrl: await context.appealUrl(),
        },
        locale,
      );
    case "post_restored":
      return moderationRestoreEmail(webOrigin, locale);
    case "user_suspended":
      return moderationSuspensionEmail(
        webOrigin,
        {
          reason: content.reason,
          expiresAt: new Date(content.expiresAt),
          appealUrl: await context.appealUrl(),
        },
        locale,
      );
    case "user_banned":
      return moderationBanEmail(
        webOrigin,
        { reason: content.reason, appealUrl: await context.appealUrl() },
        locale,
      );
    case "user_unbanned":
      return moderationUnbanEmail(webOrigin, locale);
    case "user_unsuspended":
      return moderationUnsuspensionEmail(webOrigin, locale);
    case "role_changed":
      return moderationRoleEmail(
        webOrigin,
        { role: content.role, reason: content.reason ?? undefined },
        locale,
      );
    case "case_resolved":
      return moderationCaseResolutionEmail(
        webOrigin,
        { outcome: content.outcome, note: content.note ?? undefined },
        locale,
      );
    case "appeal_resolved":
      return moderationResolutionEmail(
        webOrigin,
        { outcome: content.outcome, note: content.note ?? undefined },
        locale,
      );
  }
}
