import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "@my-tuums/db/schema";
import { db } from "./testing/runtime.js";
import {
  anonContext,
  contextFor,
  createTestUser,
  seedPosts,
  truncateAll,
} from "./testing/harness.js";
import { openAppeal } from "./appeal-intake.js";
import { moderationActionState } from "./moderation-action-state.js";
import { removePost } from "./moderation-actions.js";

beforeAll(truncateAll);
afterAll(truncateAll);

it("appeal lookups use the target index, including both target keys in the latest-action probe (issue #55)", async () => {
  const author = await createTestUser();
  const moderator = await createTestUser();
  const [target] = await seedPosts(author.id, 1);
  await removePost(anonContext, { postId: target.id, actorId: moderator.id, reason: "Fixture" });
  const captured: { sql: string; params: unknown[] }[] = [];
  const loggedDb = drizzle(db.$client, {
    schema,
    logger: { logQuery: (sql, params) => captured.push({ sql, params }) },
  });
  await openAppeal(
    { ...contextFor(author), db: loggedDb },
    {
      postId: target.id,
      reason: "Please review this removal.",
    },
  );
  const lookup = captured.find((query) => query.params.includes("post_removed"));
  if (!lookup) throw new Error("appeal intake did not issue its removal lookup");
  const lookupPlan = await db.$client
    .prepare(`explain query plan ${lookup.sql}`)
    .bind(...lookup.params)
    .all<{ detail: string }>();
  expect(
    lookupPlan.results.some((row) =>
      row.detail.includes("SEARCH moderation_action USING INDEX moderation_action_target_idx"),
    ),
  ).toBe(true);

  // Explain the exact shared predicate used inside intake/review D1 batches.
  // Bind parameters through D1; never interpolate values into captured SQL.
  const latest = db
    .select({ latest: moderationActionState.latest })
    .from(schema.moderationAction)
    .where(eq(schema.moderationAction.id, crypto.randomUUID()))
    .toSQL();
  const latestPlan = await db.$client
    .prepare(`explain query plan ${latest.sql}`)
    .bind(...latest.params)
    .all<{ detail: string }>();
  expect(
    latestPlan.results.find((row) => row.detail.startsWith("SEARCH newer_action"))?.detail,
  ).toContain(
    "USING INDEX moderation_action_target_idx (target_type=? AND target_post_id=? AND target_user_id=?",
  );
});
