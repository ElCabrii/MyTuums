// drizzle-kit config. Package scripts invoke it through `dotenv -e ../../.env`,
// so DATABASE_URL comes from the repo-root .env. `out: "./drizzle"` is
// committed, not regenerated on demand: the SQL ships inside the server's
// Docker image for the pre-deploy migration step.
import { defineConfig } from "drizzle-kit";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL is not set. Define it in your environment (see .env.example) before running drizzle-kit.",
  );
}

export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: databaseUrl,
  },
});
