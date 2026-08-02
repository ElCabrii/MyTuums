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
