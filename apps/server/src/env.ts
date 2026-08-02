import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  BETTER_AUTH_SECRET: z
    .string()
    .min(32, "BETTER_AUTH_SECRET must be at least 32 characters long"),
  BETTER_AUTH_URL: z.string().min(1, "BETTER_AUTH_URL is required"),
  WEB_ORIGIN: z.string().default("http://localhost:5173"),
  PORT: z.coerce.number().default(3001),
  HOST: z.string().default("127.0.0.1"),
  // Off by default: see the header of ./client-ip.ts for why trusting
  // X-Forwarded-For unconditionally would defeat the rate limiter rather
  // than help it. Turn this on only when a reverse proxy you control sets
  // the header.
  TRUST_PROXY: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),

  // Everything below is optional, and `packages/auth/src/env.ts` reads it
  // again independently (that package has to work when imported by the
  // BetterAuth CLI, with no server around). This schema is not the source of
  // those values — it is the loud check that a *half*-filled pair gets caught
  // at boot, which is the failure the `.superRefine` below exists for.
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  DISCORD_CLIENT_ID: z.string().optional(),
  DISCORD_CLIENT_SECRET: z.string().optional(),
  TWITCH_CLIENT_ID: z.string().optional(),
  TWITCH_CLIENT_SECRET: z.string().optional(),

  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),

  // Defaults to WEB_ORIGIN's hostname in packages/auth. Only set this when the
  // browser origin and the intended WebAuthn Relying Party differ.
  PASSKEY_RP_ID: z.string().optional(),

  // Escape hatch for the Playwright suite, which drives every sign-in from one
  // IP. See the comment on `authRateLimitEnabled` in packages/auth/src/env.ts.
  AUTH_RATE_LIMIT: z.enum(["true", "false"]).optional(),
})
  /**
   * A provider configured with only half its credentials is the failure worth
   * catching here. `packages/auth/src/social.ts` registers a provider only when
   * both halves are present, so an id without a secret doesn't error — the
   * provider just silently isn't there, its button never renders, and nothing
   * anywhere says why. Ten minutes of confusion, or one line at boot.
   */
  .superRefine((env, ctx) => {
    for (const provider of ["GOOGLE", "DISCORD", "TWITCH"] as const) {
      const id = env[`${provider}_CLIENT_ID`];
      const secret = env[`${provider}_CLIENT_SECRET`];
      if (!id === !secret) continue;

      const missing = id ? `${provider}_CLIENT_SECRET` : `${provider}_CLIENT_ID`;
      ctx.addIssue({
        code: "custom",
        path: [missing],
        message: `is required because ${
          id ? `${provider}_CLIENT_ID` : `${provider}_CLIENT_SECRET`
        } is set — a provider missing either half is not registered at all`,
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

/**
 * Validates `source` against the schema and returns it, or throws a
 * human-readable `Error` listing every violated field.
 *
 * Deliberately does not touch `process.exit` — that used to happen right
 * here at module scope, which meant *importing* this file could kill the
 * process, and nothing that imports it (a future unit test included) could
 * observe an invalid environment without dying too. The one caller that
 * actually wants "bad env means the process should not start" is the real
 * entrypoint, `src/index.ts`; it catches this and exits deliberately, with
 * the exit call visibly next to the reason for it.
 */
export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    const flattened = z.flattenError(parsed.error).fieldErrors;
    const lines = Object.entries(flattened).map(([key, messages]) => {
      return `  - ${key}: ${(messages ?? []).join(", ")}`;
    });

    throw new Error(
      [
        "Invalid or missing environment variables:",
        ...lines,
        "",
        "Check your .env file (see .env.example) and try again.",
      ].join("\n"),
    );
  }

  return parsed.data;
}
