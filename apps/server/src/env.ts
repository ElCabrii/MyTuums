import { z } from "zod";

const envSchema = z
  .object({
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    BETTER_AUTH_SECRET: z
      .string()
      .min(32, "BETTER_AUTH_SECRET must be at least 32 characters long"),
    BETTER_AUTH_URL: z.string().min(1, "BETTER_AUTH_URL is required"),
    WEB_ORIGIN: z.string().default("http://localhost:5173"),
    PORT: z.coerce.number().default(3001),
    HOST: z.string().default("127.0.0.1"),
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

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

    // Sentry error tracking (apps/server/src/sentry.ts). Optional: without it
    // the server runs with no error-tracking client — the dev/CI state. The
    // SDK's capture calls are no-ops then, so nothing gates on this.
    SENTRY_DSN: z.string().optional(),

    // Defaults to WEB_ORIGIN's hostname in packages/auth. Only set this when the
    // browser origin and the intended WebAuthn Relying Party differ.
    PASSKEY_RP_ID: z.string().optional(),

    // Escape hatch for the Playwright suite, which drives every sign-in from one
    // IP. See the comment on `authRateLimitEnabled` in packages/auth/src/env.ts.
    AUTH_RATE_LIMIT: z.enum(["true", "false"]).optional(),

    // Object storage for avatars and banners — a Railway Storage Bucket in every
    // environment, including dev and CI. All optional as a group: with none of
    // them set the server boots and everything except the two upload procedures
    // works, exactly like an unconfigured OAuth provider. `packages/api/src/
    // context.ts` reads these again to build the client; as with the OAuth pairs
    // above, this schema is not the source of the values, only the loud check
    // that a partial group is caught at boot.
    //
    // Railway names these ENDPOINT/BUCKET/ACCESS_KEY_ID/SECRET_ACCESS_KEY/REGION
    // on the bucket itself; map them onto these with reference variables.
    S3_ENDPOINT: z.string().optional(),
    S3_BUCKET: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    S3_REGION: z.string().optional(),

    // Absolute path to the built web app (apps/web/dist). When set, this server
    // also serves the SPA, which is what makes the deployed app single-origin —
    // `apps/web/src/lib/orpc.ts` resolves /rpc against window.location.origin,
    // and uploaded images are stored as relative /media/ paths. Unset in dev.
    WEB_DIST: z.string().optional(),
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

    /**
     * The same rule, one step stricter because the group is four wide: a
     * bucket configured with three of its four required variables is not
     * "partially working", it is uploads failing at runtime with an S3 error
     * nobody can trace back to a missing line in `.env`. S3_REGION is excluded
     * on purpose — it genuinely has a default (`auto`).
     */
    const s3Required = [
      "S3_ENDPOINT",
      "S3_BUCKET",
      "S3_ACCESS_KEY_ID",
      "S3_SECRET_ACCESS_KEY",
    ] as const;
    const s3Present = s3Required.filter((key) => Boolean(env[key]));

    if (s3Present.length > 0 && s3Present.length < s3Required.length) {
      for (const key of s3Required.filter((k) => !env[k])) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `is required because ${s3Present.join(", ")} ${
            s3Present.length === 1 ? "is" : "are"
          } set — image uploads need the whole S3_* group or none of it`,
        });
      }
    }
  });

/**
 * The validated shape `parseEnv` returns — every environment field the server
 * reads, defaults and transforms already applied.
 */
type Env = z.infer<typeof envSchema>;

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
