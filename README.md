# MyTuums

A Twitter-style social app — posts, likes, follows, profiles, auth. React 19 +
Vite SPA, Node 22 + oRPC API, Postgres + Drizzle, hosted on Railway.

**What the product is → [PRODUCT.md](PRODUCT.md)** · this README is about
developing it. Claude Code's own guidance lives in [CLAUDE.md](CLAUDE.md).

## Stack

| Layer                  | Tech                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| Monorepo               | pnpm 10 + Turborepo, Node 22, TypeScript strict everywhere                                        |
| Web (`apps/web`)       | React 19, Vite, TanStack Router, Jotai atoms, Paraglide i18n, shadcn/ui (base-maia, zinc, lucide) |
| Server (`apps/server`) | Node `http` server: `/api/auth` (better-auth) → `/rpc` (oRPC) → `/media` → static SPA             |
| Packages               | `api` (oRPC contract), `auth` (better-auth composition), `db` (Drizzle + postgres.js)             |
| Hosting                | Railway, EU region — production serves the built SPA from the API (one origin)                    |

## Quick start

Requires Node 22 and pnpm 10. Copy `.env.example` → `.env` first — it is the
single source of env for every host-side process.

```bash
pnpm install
pnpm docker:up   # Postgres :5432 + server image :3001 (migrations applied before the server starts)
# or, for host-side dev (API :3001, Vite :5173 — ports clash, run one):
pnpm dev
```

## Common commands

| Command                                                                    | What                                                                                  |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `pnpm build` / `pnpm lint` / `pnpm typecheck`                              | turbo across the workspace                                                            |
| `pnpm test:unit`                                                           | vitest unit suites (pure logic, no DB)                                                |
| `pnpm db:test:setup && pnpm test:integration`                              | API integration against real Postgres                                                 |
| `pnpm test:e2e`                                                            | Playwright (slow; own ports :3101/:5273)                                              |
| `pnpm db:generate` / `db:push` / `db:promote`                              | migration from schema changes / apply / role grant (root aliases into `@my-tuums/db`) |
| `pnpm --filter @my-tuums/db db:migrate` / `db:studio` / `db:generate:auth` | the rest of the Drizzle toolbox, package-level                                        |
| `pnpm --filter @my-tuums/api exec vitest run src/foo.int.test.ts`          | single test (same pattern for web)                                                    |

## Repository layout

- **`apps/web`** — the SPA. TanStack file routes in `src/routes/`; client
  state in `src/atoms/` as Jotai atoms (never `useState` for shared state);
  i18n messages in `messages/` compiled by Paraglide (never hand-edit
  `src/paraglide/**`). The route tree and Paraglide output are git-ignored
  generated files — build once before typecheck.
- **`apps/server`** — the routing tree in `request-handler.ts` (health →
  auth → rpc → media → SPA), zod-validated env in `env.ts` (a _partial_
  OAuth or S3 pair refuses to boot), graceful shutdown that drains the DB
  pool. Bundled with tsup.
- **`packages/api`** — oRPC procedures (`me`, `post`, `user`) over Drizzle;
  rate limiting keyed on the signed-in user; feeds keyset-paginated on
  `(created_at, id)`; presigned S3 uploads with WebP dimension parsing.
- **`packages/auth`** — better-auth with username, two-factor, passkey,
  oneTap, last-login-method, i18n; social providers only register when the
  full credential pair exists.
- **`packages/db`** — Drizzle schema (`src/schema/`) + committed migrations
  (`drizzle/`, shipped in the Docker image); destructive test helpers refuse
  to run against databases whose name doesn't end in `_test`.
- **`e2e`** — Playwright: `setup` (signs up alice/bob once), `api`
  (transport-level, no browser), `chromium` (browser specs). Single worker.

Each package also carries its own `AGENTS.md` - the authoritative
per-package deep-dive (file map, load-bearing decisions, commands).

## Conventions (hard rules)

- **UI: shadcn only.** Add components with the shadcn CLI; never another
  component library or hand-rolled styled primitives.
- **State: Jotai atoms, not hooks.** Server state via
  `jotai-tanstack-query` atoms; reach for `useState`/`useEffect` only when
  there is no atom-shaped way.
- **Strict TS/ESLint configs are deliberate.** Fix the code, never weaken
  the configs to make a check pass.

## Testing & CI

GitHub Actions (`ci.yml`): lint & typecheck, unit (deliberately no DB),
integration (Postgres service), e2e (Postgres + ci-bucket S3), Docker image
build (which boots the image and probes it over HTTP). A scheduled production
smoke check (`smoke.yml`) probes the live domain. Security policy:
[SECURITY.md](SECURITY.md).

## Deployment

Railway, always in a European region. The `production` environment owns the
server, Postgres, and its bucket; `dev` and `ci` are buckets-only
(Postgres and the monorepo run locally). Deploys build
`apps/server/Dockerfile` (multi-stage: tsup bundle, Vite web build,
migrations) and run migrations as a pre-deploy step. Railway must pass
`VITE_SOCIAL_PROVIDERS` / `VITE_GOOGLE_CLIENT_ID` as Docker build args or the
OAuth buttons silently don't ship (CI asserts this).

## Env gotchas

- `S3_BUCKET` is the bucket's **globally unique** name, not its display name;
  `S3_ENDPOINT` must be the public endpoint (`storage.railway.internal` only
  resolves inside Railway's network).
- `VITE_SOCIAL_PROVIDERS` must agree with the providers that have
  credentials server-side — the two lists are kept in agreement by hand.
- `BETTER_AUTH_SECRET` must be ≥ 32 chars of real randomness.
- `DATABASE_URL_TEST` is optional; when unset it is derived from
  `DATABASE_URL` with a `_test` suffix.
