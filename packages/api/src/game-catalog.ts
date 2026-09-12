import type { Database } from "@my-tuums/db";
import type { StagedGameRow } from "./games-sync.js";

const clock = "cast(unixepoch('subsec') * 1000 as integer)";
const holdsLease = `exists (select 1 from game_catalog_state where id = 1 and running_version = ?)`;
const ownsLease = `exists (select 1 from game_catalog_state
  where id = 1 and running_version = ? and lease_until > ${clock})`;

export class CatalogLeaseError extends Error {
  constructor() {
    super("The game catalog publisher is busy or this run's lease has expired.");
    this.name = "CatalogLeaseError";
  }
}

/** A newer or identical scheduled snapshot is already visible. */
export class CatalogAlreadyCurrent extends Error {
  constructor() {
    super("This scheduled game catalog snapshot has already been superseded or published.");
    this.name = "CatalogAlreadyCurrent";
  }
}

/** Acquire before reading the active catalog or starting external work. */
export async function beginGameCatalog(
  db: Database,
  syncedAt: Date,
  skipIfCurrent = false,
): Promise<string> {
  const id = crypto.randomUUID();
  const prepare = (query: string) => db.$client.prepare(query);
  const results = await db.$client.batch([
    prepare("insert into game_catalog_state (id) values (1) on conflict do nothing"),
    prepare(`insert into game_catalog_version (id, synced_at)
      select ?, ? where exists (select 1 from game_catalog_state
        where id = 1 and (running_version is null or lease_until <= ${clock}))
      and (? = 0 or not exists (select 1 from game_catalog_state s join game_catalog_version v
        on v.id = s.active_version where s.id = 1 and v.synced_at >= ?))`).bind(
      id,
      syncedAt.getTime(),
      skipIfCurrent ? 1 : 0,
      syncedAt.getTime(),
    ),
    prepare(`update game_catalog_state set running_version = ?, lease_until = ${clock} + 1800000
      where id = 1 and exists (select 1 from game_catalog_version where id = ?)
      returning running_version`).bind(id, id),
  ]);
  if (results[2]?.results.length !== 1) {
    if (
      skipIfCurrent &&
      (await prepare(`select 1 from game_catalog_state s join game_catalog_version v
      on v.id = s.active_version where s.id = 1 and v.synced_at >= ?`)
        .bind(syncedAt.getTime())
        .first())
    )
      throw new CatalogAlreadyCurrent();
    throw new CatalogLeaseError();
  }
  return id;
}

/** Fencing survives process crashes: a replacement owner invalidates every old write. */
export async function releaseGameCatalog(db: Database, id: string): Promise<void> {
  await db.$client
    .prepare(
      `update game_catalog_state set running_version = null, lease_until = null
    where id = 1 and running_version = ?`,
    )
    .bind(id)
    .run();
}

/** Reap at most 250 staged rows, then empty versions; active and running builds survive. */
export async function cleanupGameCatalogVersions(db: Database): Promise<void> {
  const unused = `id not in (select active_version from game_catalog_state where active_version is not null)
    and id not in (select running_version from game_catalog_state where running_version is not null)`;
  await db.$client.batch([
    db.$client.prepare(`update game_catalog_state set running_version = null, lease_until = null
      where running_version is not null and lease_until <= ${clock}`),
    db.$client.prepare(`delete from game_catalog_row where (version_id, igdb_id) in (
      select version_id, igdb_id from game_catalog_row where version_id in (
        select id from game_catalog_version where ${unused}) order by version_id, igdb_id limit 250)`),
    db.$client.prepare(`delete from game_catalog_version where id in (
      select id from game_catalog_version where ${unused}
      and not exists (select 1 from game_catalog_row where version_id = game_catalog_version.id)
      order by synced_at, id limit 10)`),
  ]);
}

/** Each page is retryable; only this version's invisible rows change. */
export async function stageGameCatalog(
  db: Database,
  id: string,
  rows: readonly StagedGameRow[],
): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += 40) {
    const page = rows.slice(offset, offset + 40);
    const result = await db.$client
      .prepare(
        `insert into game_catalog_row (version_id, igdb_id, payload)
      select ?, json_extract(value, '$.igdbId'), value from json_each(?)
      where ${ownsLease} and exists (select 1 from game_catalog_version where id = ? and published_at is null)
      on conflict (version_id, igdb_id) do update set payload = excluded.payload
      returning igdb_id`,
      )
      .bind(id, JSON.stringify(page), id, id)
      .all();
    if (result.results.length !== page.length) throw new CatalogLeaseError();
  }
}

/**
 * Publish the complete staged version and its indexed live projection together.
 * Favorites reference stable game IDs, never a disposable version. Omitted
 * incumbents or changed hashtag identities refuse publication. A late failure
 * rolls back the version stamp, every game update and the active pointer.
 */
export async function publishGameCatalog(
  db: Database,
  id: string,
  expectedRows: number,
): Promise<void> {
  const existing = await db.$client
    .prepare(`select 1 from game_catalog_state where id = 1 and active_version = ?`)
    .bind(id)
    .first();
  if (existing) return;
  const prepare = (query: string) => db.$client.prepare(query);
  const results = await db.$client.batch([
    prepare(`update game_catalog_version set published_at = ${clock}
      where id = ? and published_at is null and ${ownsLease}
      and ? > 0 and (select count(*) from game_catalog_row where version_id = ?) = ?
      and not exists (select 1 from game as current left join game_catalog_row as staged
        on staged.version_id = ? and staged.igdb_id = current.igdb_id
        where staged.igdb_id is null or json_extract(staged.payload, '$.hashtagKey') != current.hashtag_key)
      and not exists (select 1 from game_catalog_row as staged left join game as current on current.igdb_id = staged.igdb_id
        where staged.version_id = ? and json_extract(staged.payload, '$.coverMediaPath') is not null
        and json_extract(staged.payload, '$.coverMediaPath') is not current.cover_media_path
        and not exists (select 1 from media_intent, json_each(media_intent.paths) as path
          where media_intent.scope = ? and kind = 'upload' and ready_at > ${clock}
          and path.value = json_extract(staged.payload, '$.coverMediaPath')))
      returning id`).bind(id, id, expectedRows, id, expectedRows, id, id, `catalog:${id}`),
    prepare(`insert into game (igdb_id, slug, hashtag_key, name, summary, cover_media_path, cover_image_id,
      first_release_year, first_release_date, hype_count, genres, platforms, popularity_rank, last_synced_at)
      select staged.igdb_id, json_extract(payload, '$.slug'), json_extract(payload, '$.hashtagKey'),
        json_extract(payload, '$.name'), json_extract(payload, '$.summary'), json_extract(payload, '$.coverMediaPath'),
        json_extract(payload, '$.coverImageId'), json_extract(payload, '$.firstReleaseYear'),
        json_extract(payload, '$.firstReleaseDate'), json_extract(payload, '$.hypeCount'),
        json_extract(payload, '$.genres'), json_extract(payload, '$.platforms'),
        json_extract(payload, '$.popularityRank'), version.synced_at
      from game_catalog_row as staged join game_catalog_version as version on version.id = staged.version_id
      where version.id = ? and version.published_at is not null and ${holdsLease}
      on conflict (igdb_id) do update set slug = excluded.slug, name = excluded.name,
        summary = excluded.summary, cover_media_path = excluded.cover_media_path, cover_image_id = excluded.cover_image_id,
        first_release_year = excluded.first_release_year, first_release_date = excluded.first_release_date,
        hype_count = excluded.hype_count, genres = excluded.genres, platforms = excluded.platforms,
        popularity_rank = excluded.popularity_rank, last_synced_at = excluded.last_synced_at`).bind(
      id,
      id,
    ),
    prepare(`update game_catalog_state set active_version = ? where id = 1 and ${holdsLease}
      and exists (select 1 from game_catalog_version where id = ? and published_at is not null)
      returning active_version`).bind(id, id, id),
    prepare(`delete from media_intent where scope = ? and kind = 'upload'
      and exists (select 1 from game_catalog_state where active_version = ?)
      and exists (select 1 from json_each(media_intent.paths) as path join game on game.cover_media_path = path.value)`).bind(
      `catalog:${id}`,
      id,
    ),
  ]);
  if (results[2]?.results.length !== 1) {
    throw new CatalogLeaseError();
  }
}
