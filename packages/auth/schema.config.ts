import { drizzle } from "drizzle-orm/sqlite-proxy";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { configureAuth } from "./src/index.js";

// Schema generation needs the adapter's dialect and the real auth plugins,
// but must never query any database or send messages.
const database = drizzle(() =>
  Promise.reject(new Error("Schema generation cannot query a database")),
);
export const auth = configureAuth({
  database: drizzleAdapter(database, { provider: "sqlite" }),
  origin: "http://localhost:8787",
  secret: "schema-generation-only-not-a-deployment-secret",
  sendEmail: () => Promise.reject(new Error("Schema generation cannot send email")),
  onUserCreated: () => Promise.reject(new Error("Schema generation cannot create users")),
});
