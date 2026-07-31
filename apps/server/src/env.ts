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
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const flattened = z.flattenError(parsed.error).fieldErrors;
  const lines = Object.entries(flattened).map(([key, messages]) => {
    return `  - ${key}: ${(messages ?? []).join(", ")}`;
  });

  console.error(
    [
      "Invalid or missing environment variables:",
      ...lines,
      "",
      "Check your .env file (see .env.example) and try again.",
    ].join("\n"),
  );

  process.exit(1);
}

export const env = Object.freeze(parsed.data);
