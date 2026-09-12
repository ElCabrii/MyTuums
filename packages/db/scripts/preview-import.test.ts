import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  preparePreviewImport,
  prepareProductionImport,
  type PreviewSnapshot,
} from "./preview-import.js";

const migrations = fileURLToPath(new URL("../drizzle-d1", import.meta.url));
const names = [
  "account",
  "appeal",
  "feed_rank_snapshot",
  "follow",
  "follow_request",
  "game",
  "game_favorite",
  "link_card",
  "moderation_action",
  "notification",
  "notification_last_seen",
  "passkey",
  "post",
  "post_attachment",
  "post_bookmark",
  "post_edit",
  "post_like",
  "post_repost",
  "rate_limit",
  "report",
  "session",
  "two_factor",
  "user",
  "user_badge",
  "user_block",
  "verification",
  "video",
  "video_cleanup",
  "video_submission",
];
function fixture(): PreviewSnapshot {
  return {
    environmentId: "d6bc4115-1b88-4c56-abc6-f50b150da78c",
    capturedAt: "2026-09-12T00:00:00Z",
    tables: names.map((name) => ({ name, columns: {}, rows: [] })),
  };
}
function sourceFromSeed(sql: string) {
  const source = fixture();
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(preparePreviewImport(JSON.stringify(source), "{}", migrations).sql);
    db.exec(sql);
    for (const table of source.tables) {
      table.rows = z
        .array(z.record(z.string(), z.json()))
        .parse(db.prepare(`SELECT * FROM "${table.name}"`).all());
      table.columns = Object.fromEntries(
        db
          .prepare(`PRAGMA table_info("${table.name}")`)
          .all()
          .map((column) => [String(column.name), column.type === "INTEGER" ? "integer" : "text"]),
      );
    }
    return source;
  } finally {
    db.close();
  }
}
const user = `INSERT INTO user (id, name, email, created_at, updated_at, username, display_username) VALUES ('u', 'L''été 🎮', 'fixture@example.invalid', 1789171200123, 1789171200123, 'fixture', 'fixture');`;

await test("production and preview imports reject each other's source snapshots", () => {
  const preview = JSON.stringify(fixture());
  const production = JSON.stringify({
    ...fixture(),
    environmentId: "814c546d-cae5-4e1f-bd9f-7930eae09ea8",
  });
  assert.throws(() => prepareProductionImport(preview, "{}", migrations));
  assert.throws(() => preparePreviewImport(production, "{}", migrations));
  assert.equal(prepareProductionImport(production, "{}", migrations).report.totalRows, 0);
});

await test("preview import preserves auth values, Unicode, JSON arrays and millisecond timestamps, then restores triggers", () => {
  const source = sourceFromSeed(`${user}
    INSERT INTO account (id, account_id, provider_id, user_id, password, created_at, updated_at) VALUES ('a', 'u', 'credential', 'u', 'synthetic-password-hash', 1789171200123, 1789171200123);
    INSERT INTO two_factor (id, secret, backup_codes, user_id) VALUES ('t', 'synthetic-encrypted-secret', 'synthetic-encrypted-backup-codes', 'u');
    INSERT INTO game (igdb_id, slug, hashtag_key, name, last_synced_at) VALUES (1, 'fixture', 'fixture', 'Fixture', 1789171200123);
    INSERT INTO game_favorite (game_id, user_id) VALUES (1, 'u');`);
  const users = source.tables.find((table) => table.name === "user");
  const games = source.tables.find((table) => table.name === "game");
  assert.ok(users?.rows[0] && games?.rows[0]);
  users.columns.created_at = "timestamp with time zone";
  users.rows[0].created_at = "2026-09-12T00:00:00.123+00:00";
  games.columns.genres = "ARRAY";
  games.rows[0].genres = ["Role-playing (RPG)", "Adventure"];
  const prepared = preparePreviewImport(JSON.stringify(source), "{}", migrations);
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(prepared.sql);
    assert.equal(db.prepare("SELECT name FROM user").get()?.name, "L'été 🎮");
    assert.equal(db.prepare("SELECT created_at FROM user").get()?.created_at, 1789171200123);
    assert.equal(
      db.prepare("SELECT password FROM account").get()?.password,
      "synthetic-password-hash",
    );
    assert.equal(
      db.prepare("SELECT secret FROM two_factor").get()?.secret,
      "synthetic-encrypted-secret",
    );
    assert.equal(
      db.prepare("SELECT genres FROM game").get()?.genres,
      '["Role-playing (RPG)","Adventure"]',
    );
    assert.equal(db.prepare("SELECT favorite_count FROM game").get()?.favorite_count, 1);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    db.exec("DELETE FROM game_favorite");
    assert.equal(db.prepare("SELECT favorite_count FROM game").get()?.favorite_count, 0);
    assert.equal(db.prepare("SELECT count(*) AS count FROM __drizzle_migrations").get()?.count, 7);
    assert.equal(db.prepare("SELECT count(*) AS count FROM moderation_email").get()?.count, 0);
  } finally {
    db.close();
  }
});

await test("preview import fails closed for incomplete, duplicate and foreign-environment snapshots", () => {
  assert.throws(() =>
    preparePreviewImport(
      JSON.stringify({ ...fixture(), environmentId: "production" }),
      "{}",
      migrations,
    ),
  );
  const incomplete = fixture();
  incomplete.tables = incomplete.tables.filter((table) => table.name !== "session");
  assert.throws(
    () => preparePreviewImport(JSON.stringify(incomplete), "{}", migrations),
    /Missing source table/,
  );
  const duplicate = fixture();
  duplicate.tables.push({ name: "user", columns: {}, rows: [] });
  assert.throws(
    () => preparePreviewImport(JSON.stringify(duplicate), "{}", migrations),
    /Duplicate source table/,
  );
});

await test("preview import refuses missing relationships and aggregate drift", () => {
  const source = sourceFromSeed(
    `${user} INSERT INTO game (igdb_id, slug, hashtag_key, name, last_synced_at) VALUES (1, 'fixture', 'fixture', 'Fixture', 1);`,
  );
  const games = source.tables.find((table) => table.name === "game");
  assert.ok(games?.rows[0]);
  games.rows[0].favorite_count = 3;
  assert.throws(
    () => preparePreviewImport(JSON.stringify(source), "{}", migrations),
    /Reconciliation failed: game/,
  );
  const follows = fixture();
  const follow = follows.tables.find((table) => table.name === "follow");
  assert.ok(follow);
  follow.columns = { follower_id: "text", following_id: "text", created_at: "integer" };
  follow.rows = [{ follower_id: "missing", following_id: "also-missing", created_at: 1 }];
  assert.throws(
    () => preparePreviewImport(JSON.stringify(follows), "{}", migrations),
    /FOREIGN KEY/,
  );
});

await test("preview import refuses unfinished video work and unpublished Stream mappings", () => {
  const source = fixture();
  const videos = source.tables.find((table) => table.name === "video");
  assert.ok(videos);
  videos.columns = { id: "uuid", state: "text" };
  videos.rows = [{ id: "9438c133-0f6f-4048-a443-3cebea04e420", state: "processing" }];
  assert.throws(
    () => preparePreviewImport(JSON.stringify(source), "{}", migrations),
    /Drain active legacy videos/,
  );
  videos.rows[0] = { id: "9438c133-0f6f-4048-a443-3cebea04e420", state: "published" };
  assert.throws(
    () => preparePreviewImport(JSON.stringify(source), "{}", migrations),
    /verified environment-specific Stream mapping/,
  );
});
