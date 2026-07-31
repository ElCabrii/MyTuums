import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { username } from "better-auth/plugins";
import { db } from "@my-tuums/db";

// WEB_ORIGIN is optional with a dev-friendly default, matching the fallback
// in apps/server/src/env.ts (the loud boot-time validator for the app).
const webOrigin = process.env.WEB_ORIGIN || "http://localhost:5173";

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
  }),
  emailAndPassword: {
    enabled: true,
  },
  plugins: [
    username({
      minUsernameLength: 3,
      maxUsernameLength: 20,
      usernameValidator: (u) => /^[a-zA-Z0-9_-]+$/.test(u),
    }),
  ],
  trustedOrigins: [webOrigin],
  rateLimit: {
    storage: "database",
  },
});
