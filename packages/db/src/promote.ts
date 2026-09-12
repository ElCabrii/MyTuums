import { and, eq, sql } from "drizzle-orm";
import type { Database } from "./index.js";
import { user } from "./schema/index.js";

// The database package cannot import API roles. Keep these in step with USER_ROLES.
const PROMOTABLE_ROLES = ["moderator", "staff", "admin"];

/** Expected operator refusals, distinct from private database errors. */
export class PromotionError extends Error {}

/** Bootstrap only: after the first admin, audited role changes belong to moderation.setRole. */
export async function promoteUser(db: Database, username: string, role: string): Promise<string> {
  if (!PROMOTABLE_ROLES.includes(role)) {
    throw new PromotionError(
      `Unknown role "${role}" — expected one of ${PROMOTABLE_ROLES.join(", ")}.`,
    );
  }
  // D1 serializes the batch: concurrent bootstrap commands cannot appoint
  // multiple admins, or change another role after bootstrap has completed.
  const [admins, promoted] = await db.batch([
    db.select({ id: user.id }).from(user).where(eq(user.role, "admin")).limit(1),
    db
      .update(user)
      .set({ role })
      .where(
        and(
          eq(user.username, username),
          sql`not exists (select 1 from "user" where role = 'admin')`,
        ),
      )
      .returning({ username: user.username, name: user.name }),
  ]);
  if (admins.length) {
    throw new PromotionError(
      "Bootstrap is complete: an admin already exists. Use the moderation desk (moderation.setRole) to change roles.",
    );
  }
  const target = promoted[0];
  if (!target) throw new PromotionError(`No user with username "${username}".`);
  return `${target.username}${target.name ? ` (${target.name})` : ""} is now ${role}`;
}
