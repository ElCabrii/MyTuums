import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { z } from "zod";

const sourceSchema = z.object({
  environmentId: z.literal("d6bc4115-1b88-4c56-abc6-f50b150da78c"),
  capturedAt: z.string().datetime({ offset: true }),
  tables: z.array(
    z.object({
      name: z.string().regex(/^[a-z_]+$/),
      columns: z.record(z.string(), z.string()),
      rows: z.array(z.record(z.string(), z.json())),
    }),
  ),
});
export type PreviewSnapshot = z.infer<typeof sourceSchema>;
type SourceValue = z.infer<ReturnType<typeof z.json>>;
const sqlValue = z.union([z.string(), z.number(), z.null()]);
const sqlRows = z.array(z.record(z.string(), sqlValue));
type SqlValue = z.infer<typeof sqlValue>;
type SqlRow = z.infer<typeof sqlRows>[number];
const streamSchema = z.record(
  z.string().uuid(),
  z.object({
    uid: z.string().regex(/^[a-f0-9]{32}$/),
    creator: z.string(),
    ready: z.literal(true),
    requireSignedURLs: z.literal(true),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    duration: z.number().positive().max(300),
    captionLanguage: z.string().nullable(),
  }),
);

function identifier(value: string) {
  if (!/^[a-z_]+$/.test(value)) throw new Error("Unexpected SQL identifier.");
  return `"${value}"`;
}
function scalar(value: SourceValue, type: string): SqlValue {
  if (value === null) return null;
  if (type === "boolean") return z.boolean().parse(value) ? 1 : 0;
  if (type === "timestamp with time zone") {
    const timestamp = Date.parse(z.string().parse(value));
    if (!Number.isSafeInteger(timestamp)) throw new Error("Invalid source timestamp.");
    return timestamp;
  }
  if (type === "ARRAY" || type === "jsonb" || type === "json") return JSON.stringify(value);
  if (["integer", "bigint", "smallint"].includes(type)) return z.number().int().safe().parse(value);
  if (["text", "uuid", "character varying"].includes(type)) return z.string().parse(value);
  throw new Error("Unsupported source column type.");
}
function literal(value: SqlValue): string {
  if (value === null) return "NULL";
  const number = z.number().safeParse(value);
  if (number.success) return String(number.data);
  const text = z.string().parse(value);
  if (text.includes("\0")) throw new Error("Unsupported SQL value.");
  return `'${text.replaceAll("'", "''")}'`;
}
function digest(rows: SqlRow[]) {
  const canonical = rows
    .map((row) =>
      JSON.stringify(
        Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))),
      ),
    )
    .sort();
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** Prepare a new database offline. No credentials, remote target, writes to the source, or auth hooks. */
export function preparePreviewImport(
  sourceInput: string,
  streamInput: string,
  migrationsFolder: string,
) {
  const source = sourceSchema.parse(JSON.parse(sourceInput));
  const streams = streamSchema.parse(JSON.parse(streamInput));
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      'CREATE TABLE "__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)',
    );
    const migrations = readMigrationFiles({ migrationsFolder });
    for (const migration of migrations) {
      for (const sql of migration.sql) db.exec(sql);
      db.prepare('INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES (?, ?)').run(
        migration.hash,
        migration.folderMillis,
      );
    }
    const schema = db
      .prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'",
      )
      .all();
    const tableNames = schema
      .filter((item) => item.type === "table")
      .map((item) => z.string().parse(item.name));
    const sourceNames = source.tables.map((table) => table.name);
    if (new Set(sourceNames).size !== sourceNames.length)
      throw new Error("Duplicate source table.");
    // These are newly introduced native runtime tables. All legacy application tables must be present.
    const nativeOnly = new Set([
      "__drizzle_migrations",
      "game_catalog_row",
      "game_catalog_state",
      "game_catalog_version",
      "job_intent",
      "media_intent",
      "moderation_email",
      "post_media_upload",
    ]);
    for (const name of tableNames) {
      if (!nativeOnly.has(name) && !sourceNames.includes(name))
        throw new Error(`Missing source table: ${name}.`);
    }
    const expected = new Map<string, SqlRow[]>();
    for (const table of source.tables) {
      if (!tableNames.includes(table.name)) throw new Error(`Unknown source table: ${table.name}.`);
      if (["video_cleanup", "video_submission"].includes(table.name) && table.rows.length)
        throw new Error("Drain legacy video obligations before importing.");
      const targetColumns = new Set(
        db
          .prepare(`PRAGMA table_info(${identifier(table.name)})`)
          .all()
          .map((row) => row.name),
      );
      const rows = table.rows.map((input) => {
        const row: SqlRow = {};
        for (const [name, value] of Object.entries(input)) {
          if (
            table.name === "video" &&
            [
              "source_key",
              "multipart_id",
              "attempt_id",
              "attempts",
              "lease_expires_at",
              "source_deleted_at",
              "assets",
            ].includes(name)
          )
            continue;
          if (!targetColumns.has(name))
            throw new Error(`Unmapped source column: ${table.name}.${name}.`);
          const type = table.columns[name];
          if (!type) throw new Error("Missing source type information.");
          row[name] = scalar(value, type);
        }
        if (table.name === "video") {
          const id = z.string().uuid().parse(row.id);
          if (
            !["published", "failed", "cancelled", "deleted"].includes(z.string().parse(row.state))
          )
            throw new Error("Drain active legacy videos before importing.");
          row.stream_creator_id = `mytuums-preview:${id}`;
          row.stream_uid = null;
          row.upload_url = null;
          row.playback = null;
          if (row.state === "published") {
            const mapped = streams[id];
            if (!mapped || mapped.creator !== row.stream_creator_id)
              throw new Error("Published video needs a verified preview Stream mapping.");
            row.stream_uid = mapped.uid;
            row.playback = JSON.stringify({
              width: mapped.width,
              height: mapped.height,
              duration: mapped.duration,
              captionLanguage: mapped.captionLanguage,
            });
          }
        }
        if (table.name === "post_attachment" && row.video_id !== null) {
          const mapped = streams[z.string().uuid().parse(row.video_id)];
          if (!mapped) throw new Error("Video attachment needs a verified Stream mapping.");
          row.media_path = `/media/videos/${z.string().uuid().parse(row.video_id)}/master.m3u8`;
          row.width = mapped.width;
          row.height = mapped.height;
        }
        return row;
      });
      expected.set(table.name, rows);
    }
    // Import with the deployed triggers intact; restore aggregate counts after favorite insert triggers.
    db.exec("BEGIN; PRAGMA defer_foreign_keys = ON;");
    for (const [name, rows] of expected) {
      for (const row of rows) {
        const columns = Object.keys(row);
        db.prepare(
          `INSERT INTO ${identifier(name)} (${columns.map(identifier).join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
        ).run(...Object.values(row));
      }
    }
    db.exec(
      "UPDATE game SET favorite_count = (SELECT count(*) FROM game_favorite WHERE game_id = game.igdb_id)",
    );
    db.exec("COMMIT");
    if (db.prepare("PRAGMA foreign_key_check").all().length)
      throw new Error("Imported foreign key violations.");
    const report = [];
    for (const [name, rows] of expected) {
      const actual = sqlRows.parse(db.prepare(`SELECT * FROM ${identifier(name)}`).all());
      // Native-only video fields were explicitly added above, so all imported rows compare in full.
      if (actual.length !== rows.length || digest(actual) !== digest(rows))
        throw new Error(`Reconciliation failed: ${name}.`);
      report.push({ table: name, rows: rows.length, sha256: digest(actual) });
    }
    // Emit table definitions first, then parent rows before children; triggers are installed last.
    // This prevents trigger side effects and works when D1 import commits intermediate chunks.
    const remaining = new Set(tableNames);
    const ordered: string[] = [];
    while (remaining.size) {
      const next = [...remaining].find((name) =>
        db
          .prepare(`PRAGMA foreign_key_list(${identifier(name)})`)
          .all()
          .every((key) => key.table === name || !remaining.has(String(key.table))),
      );
      if (!next) throw new Error("Unsupported cross-table foreign key cycle.");
      ordered.push(next);
      remaining.delete(next);
    }
    const statements = schema
      .filter((item) => item.type === "table")
      .map((item) => `${String(item.sql)};`);
    for (const name of ordered) {
      let rows = sqlRows.parse(db.prepare(`SELECT * FROM ${identifier(name)}`).all());
      if (name === "post") {
        const pending = [...rows];
        rows = [];
        const inserted = new Set<SqlValue>();
        while (pending.length) {
          const position = pending.findIndex(
            (row) => row.parent_id === null || inserted.has(sqlValue.parse(row.parent_id)),
          );
          if (position < 0) throw new Error("Post parent cycle or missing parent.");
          const [row] = pending.splice(position, 1);
          if (!row) throw new Error("Missing post.");
          rows.push(row);
          inserted.add(sqlValue.parse(row.id));
        }
      }
      for (const row of rows)
        statements.push(
          `INSERT INTO ${identifier(name)} (${Object.keys(row).map(identifier).join(",")}) VALUES (${Object.values(row).map(literal).join(",")});`,
        );
    }
    statements.push(
      ...schema.filter((item) => item.type !== "table").map((item) => `${String(item.sql)};`),
    );
    return {
      sql: statements.join("\n") + "\n",
      report: {
        sourceCapturedAt: source.capturedAt,
        tables: report,
        migrations: migrations.map(({ hash, folderMillis }) => ({ hash, createdAt: folderMillis })),
        totalRows: report.reduce((n, table) => n + table.rows, 0),
      },
    };
  } finally {
    db.close();
  }
}
