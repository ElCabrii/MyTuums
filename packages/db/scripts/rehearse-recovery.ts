import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { parseArgs, promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { D1Database } from "@cloudflare/workers-types";
import { getPlatformProxy } from "wrangler";
import { createDatabase } from "../src/index.js";
import { runMigrations } from "../src/migrate.js";

const execute = promisify(execFile);
const migrations = fileURLToPath(new URL("../drizzle-d1", import.meta.url));
const cli = fileURLToPath(import.meta.resolve("wrangler"));

async function open(directory: string) {
  return getPlatformProxy<{ DB: D1Database }>({
    configPath: join(directory, "wrangler.json"),
    envFiles: [],
    remoteBindings: false,
    persist: { path: join(directory, ".wrangler/state/v3") },
  });
}

async function snapshot(binding: D1Database) {
  const objects = await binding
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY type,name",
    )
    .all<{ type: string; name: string; tbl_name: string; sql: string }>();
  const rows: Record<string, string[]> = {};
  for (const table of objects.results.filter((row) => row.type === "table")) {
    const contents = await binding
      .prepare(`SELECT * FROM "${table.name.replaceAll('"', '""')}"`)
      .all();
    rows[table.name] = contents.results.map((row) => JSON.stringify(row)).sort();
  }
  return { objects: objects.results, rows };
}

async function createSource(source: string) {
  const initial = await open(source);
  try {
    await runMigrations(createDatabase(initial.env.DB), migrations);
    await initial.env.DB.batch([
      initial.env.DB.prepare(
        "INSERT INTO user (id,name,email,username,created_at,updated_at) VALUES (?,?,?,?,?,?)",
      ).bind(
        "recovery-user",
        "Recovery Test",
        "recovery@example.test",
        "ReCoVeRy",
        1789110000123,
        1789110000123,
      ),
      initial.env.DB.prepare(
        "INSERT INTO game (igdb_id,slug,hashtag_key,name,cover_media_path,genres,last_synced_at) VALUES (?,?,?,?,?,?,?)",
      ).bind(
        42,
        "recovery-game",
        "recoverygame",
        "Recovery Game",
        "/media/games/recovery.webp",
        '["Adventure","Rôle"]',
        1789110000123,
      ),
      initial.env.DB.prepare("INSERT INTO game_favorite (game_id,user_id) VALUES (?,?)").bind(
        42,
        "recovery-user",
      ),
      initial.env.DB.prepare(
        "INSERT INTO post (id,author_id,content,created_at) VALUES (?,?,?,?)",
      ).bind(
        "recovery-post",
        "recovery-user",
        "Synthetic recovery text: apostrophe ' newline\nUnicode 🌍",
        1789110000123,
      ),
      initial.env.DB.prepare("INSERT INTO job_intent (id,kind,entity_id) VALUES (?,?,?)").bind(
        "recovery-job",
        "maintenance",
        "recovery-maintenance",
      ),
    ]);
    const before = await snapshot(initial.env.DB);
    assert.equal(
      await initial.env.DB.prepare("SELECT favorite_count FROM game WHERE igdb_id=42").first(
        "favorite_count",
      ),
      1,
    );
    return before;
  } finally {
    await initial.dispose();
  }
}

async function rehearse(root: string) {
  const source = join(root, "source");
  const target = join(root, "target");
  for (const [directory, name] of [
    [source, "mytuums_recovery_source_test"],
    [target, "mytuums_recovery_target_test"],
  ] as const) {
    await mkdir(directory);
    await writeFile(
      join(directory, "wrangler.json"),
      JSON.stringify({
        name,
        compatibility_date: "2026-09-10",
        d1_databases: [{ binding: "DB", database_name: name, database_id: name, remote: false }],
      }),
    );
  }
  console.log("Applying committed migrations and seeding synthetic recovery data.");
  const before = await createSource(source);
  const backup = join(root, "database.sql");
  await execute(
    process.execPath,
    [
      cli,
      "d1",
      "export",
      "mytuums_recovery_source_test",
      "--local",
      "--config",
      join(source, "wrangler.json"),
      "--output",
      backup,
    ],
    { cwd: source, timeout: 60000, maxBuffer: 2 * 1024 * 1024 },
  );
  console.log("Local D1 export completed; restoring into a fresh test database.");
  const sql = await readFile(backup, "utf8");
  assert.ok(sql.includes("__drizzle_migrations"));
  assert.ok(sql.includes("CREATE TRIGGER"));
  await execute(
    process.execPath,
    [
      cli,
      "d1",
      "execute",
      "mytuums_recovery_target_test",
      "--local",
      "--config",
      join(target, "wrangler.json"),
      "--file",
      backup,
      "--yes",
    ],
    { cwd: target, timeout: 60000, maxBuffer: 2 * 1024 * 1024 },
  );
  const restored = await open(target);
  try {
    assert.deepEqual(await snapshot(restored.env.DB), before);
    assert.deepEqual((await restored.env.DB.prepare("PRAGMA foreign_key_check").all()).results, []);
    await runMigrations(createDatabase(restored.env.DB), migrations);
    assert.deepEqual(await snapshot(restored.env.DB), before);
    await restored.env.DB.prepare("UPDATE user SET username=? WHERE id=?")
      .bind("ReStOrEd", "recovery-user")
      .run();
    assert.deepEqual(
      await restored.env.DB.prepare("SELECT username,display_username FROM user WHERE id=?")
        .bind("recovery-user")
        .first(),
      { username: "restored", display_username: "restored" },
    );
    await restored.env.DB.prepare("DELETE FROM user WHERE id=?").bind("recovery-user").run();
    assert.equal(
      await restored.env.DB.prepare("SELECT count(*) AS count FROM post").first("count"),
      0,
    );
    assert.equal(
      await restored.env.DB.prepare("SELECT favorite_count FROM game WHERE igdb_id=42").first(
        "favorite_count",
      ),
      0,
    );
    await restored.env.DB.prepare("DELETE FROM game WHERE igdb_id=42").run();
    const cleanup = await restored.env.DB.prepare(
      "SELECT paths FROM media_intent WHERE scope='catalog' AND kind='cleanup'",
    ).first("paths");
    assert.equal(cleanup, '["/media/games/recovery.webp"]');
    assert.deepEqual((await restored.env.DB.prepare("PRAGMA foreign_key_check").all()).results, []);
    console.log(
      JSON.stringify({
        status: "passed",
        schemaObjects: before.objects.length,
        tables: Object.keys(before.rows).length,
        migrations: before.rows.__drizzle_migrations.length,
        backupBytes: Buffer.byteLength(sql),
        checks: [
          "schema and data round trip",
          "foreign keys",
          "migration rerun is a no-op",
          "username triggers",
          "account deletion cascade",
          "favorite counts",
          "orphan cleanup trigger",
        ],
      }),
    );
  } finally {
    await restored.dispose();
  }
}

async function run() {
  // No target paths or remote options: the rehearsal can only touch its own files.
  parseArgs({ options: {}, allowPositionals: false });
  const directory = await mkdtemp(join(tmpdir(), "mytuums-recovery-test-"));
  try {
    await rehearse(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

try {
  await run();
} catch {
  console.error(
    "Local D1 recovery rehearsal failed. No remote resources were used. Usage: pnpm --filter @my-tuums/db db:rehearse:recovery",
  );
  process.exitCode = 1;
}
