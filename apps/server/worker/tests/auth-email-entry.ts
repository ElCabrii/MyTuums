import { createAuth, type OutgoingEmail } from "@my-tuums/auth";
import { createDatabase } from "@my-tuums/db";
import {
  moderationRemovalEmail,
  passwordResetEmail,
  verificationEmail,
  otpEmail,
} from "../../../../packages/auth/src/email.js";

// Real auth and templates, isolated D1 and a captured delivery transport.
// This fixture is never deployed or connected to an email provider.
const emails: OutgoingEmail[] = [];
let auth: ReturnType<typeof createAuth> | undefined;
export default {
  async fetch(request: Request, env: { DB: D1Database }): Promise<Response> {
    const origin = "https://auth-poc.example.test";
    const path = new URL(request.url).pathname;
    if (path === "/captured-emails") return Response.json(emails);
    if (path === "/auth-templates") {
      const link = `${origin}/verify?token=synthetic`;
      return Response.json(
        await Promise.all([
          passwordResetEmail(origin, link, "en"),
          verificationEmail(origin, link, "en"),
          otpEmail(origin, "000000", "en"),
        ]),
      );
    }
    if (path === "/moderation-template") {
      return Response.json(
        await moderationRemovalEmail(
          origin,
          {
            postText: "<script>synthetic</script>",
            attachmentCount: 0,
            reason: "synthetic reason",
            appealUrl: `${origin}/appeal?token=synthetic`,
          },
          "fr",
        ),
      );
    }
    auth ??= createAuth({
      db: createDatabase(env.DB),
      origin,
      secret: "native-auth-email-test-secret-at-least-32-chars",
      sendEmail: (email) => {
        if (email.to === "native-provider-failure@example.com") {
          throw new Error(`synthetic-provider-credential ${email.to} ${email.text}`);
        }
        emails.push(email);
        return Promise.resolve();
      },
    });
    return auth.handler(request);
  },
};
