import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/d1";
import { migrate } from "drizzle-orm/d1/migrator";
import { committedMigrationsFolder, createTestDatabase } from "@my-tuums/db/testing/d1";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Migration 0007's upgrade path, exercised over real old-world data (issue
 * #408): a database pinned at 0006 — the last world without private messages
 * and with reports restricted to posts and users — carries open and resolved
 * report rows, then the full committed set runs on top of it and must apply
 * only 0007. The report rebuild inside that migration is the risky part: it
 * must carry every row across with its resolution metadata intact, and the
 * widened target-type check must accept 'message' while still refusing
 * garbage.
 */

let cleanup: (() => Promise<void>) | null = null;
afterAll(async () => {
  await cleanup?.();
});

/** A copy of the committed migrations whose journal stops BEFORE 0007. */
async function prePrivateMessagesFolder() {
  const folder = await mkdtemp(join(tmpdir(), "mytuums-migrations-0006-"));
  await cp(committedMigrationsFolder, folder, { recursive: true });
  const journalPath = join(folder, "meta", "_journal.json");
  // SAFETY: the journal is this repo's own committed file, written by
  // drizzle-kit with exactly this shape.
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
    entries: unknown[];
  };
  const withoutLast = journal.entries.slice(0, -1);
  expect(journal.entries.length - withoutLast.length).toBe(1);
  await writeFile(
    journalPath,
    `${JSON.stringify({ ...journal, entries: withoutLast }, null, 2)}\n`,
  );
  return folder;
}

describe("migration 0007_private_messages upgrades a 0006 database", () => {
  it("creates the messaging tables and carries every report across with its resolution metadata", async () => {
    const oldFolder = await prePrivateMessagesFolder();
    const database = await createTestDatabase({ migrationsFolder: oldFolder });
    cleanup = async () => {
      await database.dispose();
      await rm(oldFolder, { recursive: true, force: true });
    };
    const client = database.db.$client;

    // The old world: two accounts and one report per shape that mattered —
    // an open case and a resolved one with the full resolution stamp.
    await client.batch([
      client
        .prepare(`insert into user (id, name, email) values (?, ?, ?), (?, ?, ?)`)
        .bind(
          "reporter-1",
          "Reporter",
          "reporter@example.com",
          "resolver-1",
          "Resolver",
          "resolver@example.com",
        ),
      client
        .prepare(
          `insert into report (reporter_id, target_type, target_id, reason, snapshot_content, created_at, resolved_at, resolved_by, resolved_outcome, resolution_note)
           values (?, 'post', ?, 'spam', 'the offending words', 1000, null, null, null, null)`,
        )
        .bind("reporter-1", "00000000-0000-4000-8000-000000000001"),
      client
        .prepare(
          `insert into report (reporter_id, target_type, target_id, reason, snapshot_content, created_at, resolved_at, resolved_by, resolved_outcome, resolution_note)
           values (?, 'user', ?, 'harassment', null, 2000, 3000, 'resolver-1', 'actioned', 'warned')`,
        )
        .bind("reporter-1", "resolver-1"),
    ]);

    // The upgrade: the full committed set, applied over the pinned database.
    await migrate(drizzle(client), { migrationsFolder: committedMigrationsFolder });

    // The messaging tables exist and start empty.
    const counts = await client.batch([
      client.prepare(`select count(*) as n from conversation`),
      client.prepare(`select count(*) as n from conversation_participant`),
      client.prepare(`select count(*) as n from message`),
    ]);
    expect(
      // SAFETY: each statement above is `select count(*) as n`, so every
      // first row carries that one column.
      counts.map((result) => (result.results[0] as { n: number }).n),
    ).toEqual([0, 0, 0]);

    // The pair-key invariant is live: canonical order enforced, self-pairs
    // and mis-ordered pairs refused.
    await expect(
      client
        .prepare(
          `insert into conversation (id, user_a_id, user_b_id) values ('c1', 'b-id', 'a-id')`,
        )
        .run(),
    ).rejects.toThrow();
    await expect(
      client
        .prepare(
          `insert into conversation (id, user_a_id, user_b_id) values ('c2', 'same', 'same')`,
        )
        .run(),
    ).rejects.toThrow();

    // The report rows survived the rebuild whole, resolution stamp included.
    const resolved = await client
      .prepare(
        `select resolved_at, resolved_by, resolved_outcome, resolution_note, snapshot_content from report where target_type = 'user'`,
      )
      .first<{
        resolved_at: number;
        resolved_by: string;
        resolved_outcome: string;
        resolution_note: string;
        snapshot_content: string | null;
      }>();
    expect(resolved).toMatchObject({
      resolved_at: 3000,
      resolved_by: "resolver-1",
      resolved_outcome: "actioned",
      resolution_note: "warned",
      snapshot_content: null,
    });

    // The widened check accepts 'message' targets and still refuses garbage.
    await client
      .prepare(
        `insert into report (reporter_id, target_type, target_id, reason) values ('reporter-1', 'message', '00000000-0000-4000-8000-00000000000f', 'nsfw')`,
      )
      .run();
    await expect(
      client
        .prepare(
          `insert into report (reporter_id, target_type, target_id, reason) values ('reporter-1', 'game', 'x', 'spam')`,
        )
        .run(),
    ).rejects.toThrow();
  });
});
