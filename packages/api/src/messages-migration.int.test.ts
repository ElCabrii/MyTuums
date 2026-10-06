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
 * the remaining migrations. The report rebuild is the risky part: it
 * must carry every row across with its resolution metadata intact, and the
 * widened target-type check must accept 'message' while still refusing
 * garbage.
 */

let cleanup: (() => Promise<void>) | null = null;
afterAll(async () => {
  await cleanup?.();
});

/** A copy of the committed migrations pinned before the upgrade under test. */
async function migrationsBefore(count: number) {
  const folder = await mkdtemp(join(tmpdir(), "mytuums-migrations-0006-"));
  await cp(committedMigrationsFolder, folder, { recursive: true });
  const journalPath = join(folder, "meta", "_journal.json");
  // SAFETY: the journal is this repo's own committed file, written by
  // drizzle-kit with exactly this shape.
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
    entries: unknown[];
  };
  const entries = journal.entries.slice(0, count);
  await writeFile(journalPath, `${JSON.stringify({ ...journal, entries }, null, 2)}\n`);
  return folder;
}

describe("migration 0007_private_messages upgrades a 0006 database", () => {
  it("creates the messaging tables and carries every report across with its resolution metadata", async () => {
    const oldFolder = await migrationsBefore(7);
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

it("preserves existing conversations during the media upgrade and retains cleanup after account deletion", async () => {
  const oldFolder = await migrationsBefore(8);
  const database = await createTestDatabase({ migrationsFolder: oldFolder });
  try {
    const client = database.db.$client;
    await client.batch([
      client.prepare(
        "insert into user (id, name, email) values ('a', 'A', 'a@example.invalid'), ('b', 'B', 'b@example.invalid')",
      ),
      client.prepare("insert into conversation (id, user_a_id, user_b_id) values ('c', 'a', 'b')"),
      client.prepare(
        "insert into conversation_participant (conversation_id, user_id, status, last_read_at) values ('c', 'a', 'active', 123), ('c', 'b', 'pending', null)",
      ),
      client.prepare(
        "insert into message (id, conversation_id, sender_id, body, created_at, deleted_at) values ('old', 'c', 'a', 'Retained words', 100, 200)",
      ),
    ]);
    await migrate(drizzle(client), { migrationsFolder: committedMigrationsFolder });
    expect(
      await client
        .prepare("select body, created_at, deleted_at from message where id = 'old'")
        .first(),
    ).toEqual({ body: "Retained words", created_at: 100, deleted_at: 200 });
    expect(
      await client
        .prepare("select status, last_read_at from conversation_participant where user_id = 'a'")
        .first(),
    ).toEqual({ status: "active", last_read_at: 123 });
    expect((await client.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);

    await client.batch([
      client.prepare(
        "insert into message (id, conversation_id, sender_id, body) values ('media', 'c', 'a', '')",
      ),
      client.prepare(
        "insert into message_attachment (id, message_id, kind, media_path, content_type, byte_size) values ('image', 'media', 'image', '/media/messages/media/image.png', 'image/png', 100)",
      ),
      client.prepare("delete from user where id = 'a'"),
    ]);
    expect(await client.prepare("select count(*) as n from message_attachment").first()).toEqual({
      n: 0,
    });
    expect(
      await client
        .prepare("select kind, paths from media_intent where scope = 'message:media'")
        .first(),
    ).toEqual({ kind: "cleanup", paths: '["/media/messages/media/image.png"]' });
  } finally {
    await database.dispose();
    await rm(oldFolder, { recursive: true, force: true });
  }
});

it("removes unreleased encrypted messages and keys while preserving plaintext history and media cleanup", async () => {
  const legacyFolder = await migrationsBefore(11);
  const encryptedFolder = await migrationsBefore(15);
  const database = await createTestDatabase({ migrationsFolder: legacyFolder });
  try {
    const client = database.db.$client;
    await client.batch([
      client.prepare(
        "insert into user (id, name, email) values ('a', 'A', 'a@example.invalid'), ('b', 'B', 'b@example.invalid'), ('c', 'C', 'c@example.invalid')",
      ),
      client.prepare(
        "insert into conversation (id, user_a_id, user_b_id, last_message_at) values ('mixed', 'a', 'b', 200), ('encrypted-only', 'a', 'c', 300)",
      ),
      client.prepare(
        "insert into conversation_participant (conversation_id, user_id, status, last_read_at) values ('mixed', 'a', 'active', 123), ('mixed', 'b', 'pending', null), ('encrypted-only', 'a', 'active', null), ('encrypted-only', 'c', 'pending', null)",
      ),
      client.prepare(
        "insert into message (id, conversation_id, sender_id, body, created_at, deleted_at) values ('legacy', 'mixed', 'a', 'Readable history', 100, null), ('tombstone', 'mixed', 'b', 'Deleted history', 110, 120)",
      ),
    ]);
    await migrate(drizzle(client), { migrationsFolder: encryptedFolder });
    await client.batch([
      client.prepare(
        "insert into message (id, conversation_id, sender_id, body, envelope, created_at) values ('encrypted-image', 'mixed', 'a', '[encrypted]', '{}', 200), ('encrypted-video', 'encrypted-only', 'a', '[encrypted]', '{}', 300)",
      ),
      client.prepare(
        "insert into video (id, author_id, state, byte_size, stream_creator_id, stream_uid, expires_at) values ('clip', 'a', 'queued', 100, 'test:clip', 'provider-clip', 999999)",
      ),
      client.prepare(
        "insert into message_attachment (id, message_id, kind, media_path, content_type, byte_size, video_id) values ('photo', 'encrypted-image', 'image', '/media/messages/encrypted-image/photo.png', 'image/png', 100, null), ('clip', 'encrypted-video', 'video', '/media/messages/encrypted-video/clip', 'video/mp4', 100, 'clip'), ('kept', 'legacy', 'image', '/media/messages/legacy/kept.png', 'image/png', 100, null)",
      ),
      client.prepare(
        "insert into message_identity (user_id, public_identity, backup, recovery_key_id) values ('a', '{}', 'test-backup', 'test-key')",
      ),
      client.prepare(
        "insert into message_recovery (user_id, id, session_id, email, code_hash, transport_key, expires_at) values ('a', 'challenge', 'session', 'a@example.invalid', 'hash', '{}', 999999)",
      ),
      client.prepare(
        "insert into report (reporter_id, target_type, target_id, reason, snapshot_content) values ('b', 'message', 'encrypted-image', 'spam', 'retained evidence')",
      ),
    ]);

    await migrate(drizzle(client), { migrationsFolder: committedMigrationsFolder });
    expect(
      (await client.prepare("select id, body, deleted_at from message order by created_at").all())
        .results,
    ).toEqual([
      { id: "legacy", body: "Readable history", deleted_at: null },
      { id: "tombstone", body: "Deleted history", deleted_at: 120 },
    ]);
    expect(
      (await client.prepare("select id, last_message_at from conversation").all()).results,
    ).toEqual([{ id: "mixed", last_message_at: 110 }]);
    expect(
      await client
        .prepare(
          "select status, last_read_at from conversation_participant where conversation_id = 'mixed' and user_id = 'a'",
        )
        .first(),
    ).toEqual({ status: "active", last_read_at: 123 });
    expect((await client.prepare("select id from message_attachment").all()).results).toEqual([
      { id: "kept" },
    ]);
    expect(
      await client
        .prepare("select kind, paths from media_intent where scope = 'message:encrypted-image'")
        .first(),
    ).toEqual({ kind: "cleanup", paths: '["/media/messages/encrypted-image/photo.png"]' });
    expect(
      await client.prepare("select stream_uid from video_cleanup where video_id = 'clip'").first(),
    ).toEqual({ stream_uid: "provider-clip" });
    expect(
      await client
        .prepare("select snapshot_content from report where target_id = 'encrypted-image'")
        .first(),
    ).toEqual({ snapshot_content: "retained evidence" });
    expect(
      (
        await client
          .prepare(
            "select name from sqlite_master where name in ('message_identity', 'message_recovery')",
          )
          .all()
      ).results,
    ).toEqual([]);
    expect(
      (await client.prepare("pragma table_info(message)").all()).results.map(
        (column) => column.name,
      ),
    ).not.toContain("envelope");
    await client
      .prepare(
        "insert into message (id, conversation_id, sender_id, body) values ('new', 'mixed', 'a', 'No recovery needed')",
      )
      .run();
    await expect(
      client.prepare("update message set body = 'altered' where id = 'new'").run(),
    ).rejects.toThrow("Message content is immutable");
    await client.prepare("update message set deleted_at = 500 where id = 'new'").run();
    expect((await client.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  } finally {
    await database.dispose();
    await rm(legacyFolder, { recursive: true, force: true });
    await rm(encryptedFolder, { recursive: true, force: true });
  }
});

it("group migration preserves messages, participant state and media without scheduling cleanup", async () => {
  const oldFolder = await migrationsBefore(18);
  const database = await createTestDatabase({ migrationsFolder: oldFolder });
  const client = database.db.$client;
  try {
    await client.batch([
      client.prepare(
        "insert into user (id, name, email) values ('a', 'A', 'a@example.invalid'), ('b', 'B', 'b@example.invalid')",
      ),
      client.prepare(
        "insert into conversation (id, user_a_id, user_b_id, last_message_at) values ('c', 'a', 'b', 200)",
      ),
      client.prepare(
        "insert into conversation_participant (conversation_id, user_id, status, last_read_at) values ('c', 'a', 'hidden', 123), ('c', 'b', 'pending', null)",
      ),
      client.prepare(
        "insert into message (id, conversation_id, sender_id, body, created_at) values ('m', 'c', 'a', 'Preserved', 200)",
      ),
      client.prepare(
        "insert into message_attachment (id, message_id, kind, media_path, content_type, byte_size) values ('img', 'm', 'image', '/media/messages/m/img.png', 'image/png', 100)",
      ),
    ]);
    await migrate(drizzle(client), { migrationsFolder: committedMigrationsFolder });
    expect(
      await client.prepare("select kind, last_message_at from conversation where id = 'c'").first(),
    ).toEqual({ kind: "direct", last_message_at: 200 });
    expect(
      await client
        .prepare(
          "select status, membership, last_read_at from conversation_participant where user_id = 'a'",
        )
        .first(),
    ).toEqual({ status: "hidden", membership: "joined", last_read_at: 123 });
    expect(await client.prepare("select body from message where id = 'm'").first()).toEqual({
      body: "Preserved",
    });
    expect(await client.prepare("select count(*) as n from message_attachment").first()).toEqual({
      n: 1,
    });
    expect(await client.prepare("select count(*) as n from media_intent").first()).toEqual({
      n: 0,
    });
    expect((await client.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    await client.prepare("delete from user where id = 'a'").run();
    expect(
      await client.prepare("select count(*) as n from media_intent where kind = 'cleanup'").first(),
    ).toEqual({ n: 1 });
  } finally {
    await database.dispose();
    await rm(oldFolder, { recursive: true, force: true });
  }
});
