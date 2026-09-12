# Repository context

Preview and production run on Cloudflare-native infrastructure. The production
cutover, exact deployed versions and retained Railway rollback data are recorded
in [the production execution record](docs/cloudflare-production-migration.md).
Preview history is in [the preview migration record](docs/cloudflare-preview-migration.md).
The original PoC history is in [the migration record](docs/cloudflare-migration.md).
Local app/jobs development uses isolated persistent native resources; see
[local development](docs/operations.md#local-development).

The repository map for MyTuums. Use the routing table to reach the context that
owns a change; use `docs/` for cross-package architecture, product behavior,
operations, and security.

## Repository

MyTuums — a Twitter-style social app (posts, replies, likes, bookmarks,
follows, profiles, moderation) with real authentication. pnpm 12 + Turborepo
on Node 24, TypeScript strict everywhere.

| Workspace           | Package                  | Owns                                                              |
| ------------------- | ------------------------ | ----------------------------------------------------------------- |
| `apps/web`          | `@my-tuums/web`          | React 19 + Vite SPA, TanStack Router, Jotai                       |
| `apps/branding`     | `@my-tuums/branding`     | the public landing site served at about.mytuums.com               |
| `apps/server`       | `@my-tuums/server`       | Cloudflare application Worker and native maintenance CLIs         |
| `apps/link-fetcher` | `@my-tuums/link-fetcher` | private Cloudflare Container for guarded rich-link HTTP           |
| `apps/jobs`         | `@my-tuums/jobs`         | Cloudflare Workflows, video processing, Cron recovery and pruning |
| `packages/api`      | `@my-tuums/api`          | oRPC procedures, business rules, media, moderation                |
| `packages/auth`     | `@my-tuums/auth`         | the single better-auth instance                                   |
| `packages/db`       | `@my-tuums/db`           | Drizzle schema, migrations, test-database guards                  |
| `e2e`               | `@my-tuums/e2e`          | Playwright journeys over the real stack                           |

## Context routing

| If the change is about                                    | Go to                                                        |
| --------------------------------------------------------- | ------------------------------------------------------------ |
| UI, routes, client state, i18n copy, theme                | [apps/web/CONTEXT.md](apps/web/CONTEXT.md)                   |
| The public landing site at `about.mytuums.com`            | [apps/branding/CONTEXT.md](apps/branding/CONTEXT.md)         |
| HTTP routing, config validation, headers, Worker runtime  | [apps/server/CONTEXT.md](apps/server/CONTEXT.md)             |
| Cloudflare background execution and scheduled recovery    | [apps/jobs/CONTEXT.md](apps/jobs/CONTEXT.md)                 |
| Outbound rich-link networking                             | [apps/link-fetcher/CONTEXT.md](apps/link-fetcher/CONTEXT.md) |
| Business rules, RPC procedures, moderation, media/storage | [packages/api/CONTEXT.md](packages/api/CONTEXT.md)           |
| Sign-in, OAuth providers, sessions, auth email            | [packages/auth/CONTEXT.md](packages/auth/CONTEXT.md)         |
| Schema, migrations, test databases                        | [packages/db/CONTEXT.md](packages/db/CONTEXT.md)             |
| End-to-end journeys                                       | [e2e/CONTEXT.md](e2e/CONTEXT.md)                             |
| Workflows, CI jobs                                        | [.github/CONTEXT.md](.github/CONTEXT.md)                     |
| Repository lint and TypeScript tooling                    | root configs, `package.json`, `tools/oxlint/`                |

Cross-package questions — how the pieces fit, what a request does end to end —
are answered in [docs/architecture.md](docs/architecture.md).

## Cross-cutting invariants

Only invariants that span packages live here. Package-local invariants belong
to the owning context.

- **The TypeScript 7 CLI and TypeScript 6 API compatibility package are both
  intentional.** `@typescript/native` supplies the `tsc` binary used by every
  typecheck, while dependencies named `typescript` resolve to
  `@typescript/typescript6` for tools such as typescript-eslint that still load
  the compiler API. Do not collapse them until those tools support the
  TypeScript 7 API.
- **One origin in production.** The server serves the built SPA, because
  `apps/web/src/lib/orpc.ts` resolves `/rpc` against `window.location.origin`
  and uploaded images are stored as relative `/media/` paths. Split them
  across origins and RPC and every image break together.
- **The signed-out allowlist has exactly one definition.**
  `packages/api/src/constants.ts` owns `SIGNED_OUT_PATHS` (exact paths) and
  the `/post/` prefix rule behind `isSignedOutPath`; the server's page gate
  and the client's `useRequireSignedIn` both read that. Duplicating it lets
  the two gates disagree and bounce a visitor between them forever.
- **The browser-safe subpaths stay dependency-free.**
  `@my-tuums/api/constants`, `@my-tuums/api/badges`,
  `@my-tuums/api/dimensions`, `@my-tuums/api/post-image`,
  `@my-tuums/api/roles` and `@my-tuums/auth/rules` must never import
  `@my-tuums/db`; the web app imports them, and a database import throws at
  module load in a browser.
  Those six are the _only_ workspace modules in the SPA bundle, and they are
  the only ones `apps/web` may import from either package.
- **Auth-owned user fields are written through the auth client only.**
  `packages/auth`'s database hooks enforce their user-field rules; an oRPC
  procedure writing them bypasses validation. The duplicated handle columns
  have one additional database invariant: migration `0015_lowercase_usernames`
  derives both lowercase values from `username`, including during a rolling
  deploy while the previous server version can still write.
- **The client's provider list and the server's credentials must agree.**
  `VITE_SOCIAL_PROVIDERS` is baked into the bundle at build time and the
  browser cannot see server env. CI asserts both halves.
- **Rate limiting is not uniform.** Most policies key on `user:<id>`; the
  signed-out appeal path keys on the capability the caller presented. See
  [docs/security.md](docs/security.md).
- **Destructive database helpers refuse any database not ending in `_test`.**
- **Migrations run as a pre-deploy step, never at server boot.** N replicas
  would race the same DDL.
- **A video worker's database owns its whole video bucket namespace.** Keep
  database/bucket pairs isolated by environment. An orphan scan against a
  different database can delete another environment's videos.
- **The account rules have exactly one definition.**
  `packages/auth/src/rules.ts` (`@my-tuums/auth/rules`) owns the handle bounds,
  charset and lowercase normalization, the date-of-birth parse and age
  comparison, the bio limit, the preference lists, and every English rejection
  string. The browser forms, the better-auth hooks and plugin config, and
  `usernameInput` in `packages/api/src/users.ts` all read it. Those strings are
  also the keys of `apps/web/src/lib/auth-error-message.ts`; restate one
  anywhere and server rejections render untranslated.

## Generated files

These artifacts are generator-owned. Run the generator and commit its output
(or nothing where the artifact is git-ignored).

| Artefact                                             | Produced by                                                               |
| ---------------------------------------------------- | ------------------------------------------------------------------------- |
| `apps/web/src/routeTree.gen.ts`                      | the TanStack Router Vite plugin (git-ignored)                             |
| `apps/web/src/paraglide`                             | `pnpm --filter @my-tuums/web paraglide` (git-ignored)                     |
| `apps/branding/src/paraglide`                        | `pnpm --filter @my-tuums/branding paraglide` (git-ignored)                |
| `packages/db/src/schema/auth.ts`                     | `pnpm --filter @my-tuums/db db:generate:auth`                             |
| `packages/api/src/unicode-case-folding.generated.ts` | `pnpm --filter @my-tuums/api generate:case-folding`, then `pnpm format`   |
| `packages/api/src/search-folding.generated.ts`       | `pnpm --filter @my-tuums/api generate:search-folding`, then `pnpm format` |
| `packages/db/drizzle-d1`                             | `pnpm db:generate` (committed, applied before Worker deployment)          |
| `apps/link-fetcher/worker/worker-configuration.d.ts` | `pnpm --filter @my-tuums/link-fetcher types`, then `pnpm format`          |
| `apps/jobs/worker-configuration.d.ts`                | `pnpm --filter @my-tuums/jobs types`, then `pnpm format`                  |
| `apps/branding/worker/worker-configuration.d.ts`     | `pnpm --filter @my-tuums/branding types`, then `pnpm format`              |
| `apps/server/worker/worker-configuration.d.ts`       | `pnpm --filter @my-tuums/server types`, then `pnpm format`                |

The two git-ignored web artefacts are why `lint` and `typecheck` depend on
`build` in `turbo.json`: `tsc` cannot resolve a route target or a message
function until one build has run.

The PostgreSQL migration history is preserved for comparison. Native jobs use
the D1 outbox and Workflows; see [video operations](docs/video-operations.md#migrations).

## Verification matrix

Three levels, widening. Use the narrowest one that can see your change while
you iterate, and `pnpm verify` before you call the work done.

| Level    | Command            | Covers                                                         |
| -------- | ------------------ | -------------------------------------------------------------- |
| **fast** | `pnpm test:unit`   | pure logic, atoms, components, the server's request handling   |
| **PR**   | `pnpm verify`      | build, lint, typecheck, format, docs, unit **and** integration |
| **full** | `pnpm verify:full` | the above plus the browser journeys (`pnpm test:e2e`)          |

`pnpm verify` is exactly what CI's `Verify` job runs — one script, so the two
cannot drift. While iterating, go narrower still:

| Change touches                | Run                                                               |
| ----------------------------- | ----------------------------------------------------------------- |
| one file                      | `pnpm --filter <pkg> exec vitest run <path>`                      |
| pure logic, atoms, components | `pnpm test:unit`                                                  |
| procedures, queries, schema   | `pnpm db:test:setup` then `pnpm test:integration`                 |
| a user journey                | `pnpm test:e2e` (slow; use only for end-to-end proof)             |
| Worker or SPA artifact        | `pnpm build`, then native artifact tests through `pnpm test:unit` |
| documentation                 | `pnpm docs:check`                                                 |

API integration tests create ephemeral local D1 databases and need no Postgres
or credentials. E2E now uses local Worker/D1/R2/Workflow bindings with a synthetic
Stream transport fixture. Hosted provider checks and interactive local development passed during the production migration.

What belongs in which suite, and when a test deserves to exist at all:
[TESTING_STRATEGY.md](TESTING_STRATEGY.md).

## Further reading

- [README.md](README.md) — human setup and commands.
- [docs/architecture.md](docs/architecture.md) — boundaries and executable flows.
- [docs/product.md](docs/product.md) — implemented behaviour and vocabulary.
- [docs/cloudflare-poc-report.md](docs/cloudflare-poc-report.md) — migration parity evidence and remaining hosted gates.
- [docs/operations.md](docs/operations.md) — environments, deploys, CI.
- [docs/security.md](docs/security.md) — trust boundaries and sensitive invariants.
- [TESTING_STRATEGY.md](TESTING_STRATEGY.md) — the test portfolio and its rules.
