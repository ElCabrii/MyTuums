# packages/db context

## Responsibility

The Postgres + Drizzle data layer: the one process-wide connection pool, the
full schema (hand-written app tables plus the generated better-auth tables),
the committed migration history, and the helpers that resolve and guard test
databases. It serves data only — no HTTP, no business logic.

## Start here

| File                | Why                                                                      |
| ------------------- | ------------------------------------------------------------------------ |
| `src/index.ts`      | Module-scope `DATABASE_URL`, the pool, the TLS rule, `closeDb`/`pingDb`. |
| `src/schema/app.ts` | The hand-written tables; its comments record the load-bearing choices.   |
| `src/testing.ts`    | Test-URL resolution and `assertTestDatabase`, the destructive guard.     |
| `drizzle.config.ts` | What drizzle-kit reads and where it writes.                              |

## Change map

| Intent                            | Primary                      | Also touch                                                                |
| --------------------------------- | ---------------------------- | ------------------------------------------------------------------------- |
| Add or change an app table        | `src/schema/app.ts`          | `pnpm db:generate`, then commit `drizzle/`; an index if a cursor reads it |
| Change an auth table              | `packages/auth/src/index.ts` | `pnpm --filter @my-tuums/db db:generate:auth`, then `pnpm db:generate`    |
| Add an index for a new list       | `src/schema/app.ts`          | the `keysetPage` call in `packages/api` it must mirror                    |
| Change how migrations are applied | `src/migrate.ts`             | `apps/server/src/migrate.ts`, `docker-compose.yml`                        |
| Change test-database handling     | `src/testing.ts`             | `scripts/setup-test-db.ts`, `e2e/global-setup.ts`                         |
| Add a maintenance script          | `scripts/`                   | the `scripts` entry in `package.json`                                     |

## Invariants

- **`src/index.ts` reads `DATABASE_URL` at module scope and throws when it is
  unset.** That is precisely why `./testing` is a separate entry point: it must
  be importable before anything touches the root subpath, so a test runner can
  compute the `_test` URL first.
- **TLS is required for dotted hostnames and disabled for loopback and
  single-label (Compose-internal) hostnames.** See the `requiresTls` comment.
- **App tables stay in `src/schema/app.ts`.** `src/schema/auth.ts` is
  regenerated wholesale; anything hand-written there is destroyed.
- **`src/schema/auth.ts` is generated.** Regenerate it with
  `pnpm --filter @my-tuums/db db:generate:auth`, which runs the better-auth CLI
  and then `scripts/patch-auth-schema.ts`. That script's header explains what
  it patches and why.
- **Composite primary keys are the idempotency mechanism.** Uniqueness for
  likes, reposts, follows, reports and blocks lives in the PK, so handlers use
  `onConflictDoNothing` instead of a read-then-write race.
- **A quote reference is deliberately FK-less.** `post.quoted_post_id` names
  another post, but a hard delete of that row (today, through its author's
  account cascade) must not delete the quoting author's own post. Readers
  resolve the reference and render the embedded post as unavailable when the
  target row is gone; do not add the self-reference cascade used by
  `post.parent_id`.
- **`timestamptz` with `precision: 3` on every `created_at`.** Microsecond
  precision silently drops rows from keyset cursors, because a JS `Date`
  carries only milliseconds. Do not "optimise" it.
- **Indexes mirror the cursors.** Every index is ordered to match the keyset
  comparison in `packages/api`; `post_created_idx` is deliberately partial
  (top-level posts only). Adding a paginated list without its index turns a
  page fetch into a table scan.
- **Migrations are committed and shipped**, applied once by the pre-deploy
  step — never at server boot, where N replicas would race the same DDL.
- **The two handle columns cannot diverge.** Migration
  `0015_lowercase_usernames` installs `user_normalize_handle_before_write`,
  which lowercases `username` and derives `display_username` from it on every
  handle insert or update. The database boundary is intentional: Railway runs
  migrations before the new application takes traffic, while the previous
  version may still write rows.
- **Destructive helpers refuse anything not ending in `_test`**
  (`assertTestDatabase`, `scripts/setup-test-db.ts`). This is the guard
  standing between a test run and the development database.
- **One pool per process.** `db` is a singleton; integration suites share it,
  which is why the API suite runs `fileParallelism: false`.

## Dependencies and boundaries

Five subpath exports, all source `.ts` — consumers compile or inline them:

| Subpath     | Exports                                    | Consumers                                               |
| ----------- | ------------------------------------------ | ------------------------------------------------------- |
| `.`         | `db`, `Database`, `closeDb`, `pingDb`      | `packages/api`, `packages/auth`, `apps/server`          |
| `./schema`  | tables and relations                       | `packages/api`, `e2e`                                   |
| `./testing` | test-URL helpers and the destructive guard | vitest configs, `e2e`                                   |
| `./migrate` | `runMigrations`                            | `apps/server/src/migrate.ts`                            |
| `./promote` | `promoteUser`                              | `scripts/promote-user.ts`, `apps/server/src/promote.ts` |

This package must not import `packages/api` or `packages/auth` — the
dependency direction is one way.

## Generated files

| Path                 | Generator                                     | Committed                             |
| -------------------- | --------------------------------------------- | ------------------------------------- |
| `src/schema/auth.ts` | `pnpm --filter @my-tuums/db db:generate:auth` | yes                                   |
| `drizzle/`           | `pnpm db:generate`                            | yes — and shipped in the Docker image |

## Verification

All package scripts load the root `.env` through `dotenv -e ../../.env`.

| Command                                         | Covers                                         |
| ----------------------------------------------- | ---------------------------------------------- |
| `pnpm db:generate`                              | new migration SQL and snapshot                 |
| `pnpm --filter @my-tuums/db db:check`           | schema drift — a schema edit with no migration |
| `pnpm db:push`                                  | apply locally                                  |
| `pnpm db:test:setup`                            | create and migrate the `_test` database        |
| `pnpm --filter @my-tuums/db db:migrate`         | apply through the migrator                     |
| `pnpm --filter @my-tuums/db db:studio`          | browse                                         |
| `pnpm --filter @my-tuums/db lint` / `typecheck` | this package alone                             |

There is no test suite here; the schema is exercised by `packages/api`'s
integration suites.

## Further reading

- [docs/architecture.md](../../docs/architecture.md) — schema split and migration lifecycle.
- [docs/operations.md](../../docs/operations.md) — how migrations run in production.
- [docs/security.md](../../docs/security.md) — the test-database guard.
