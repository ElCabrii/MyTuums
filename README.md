# MyTuums

Production and preview run on Cloudflare. The completed cutover and rollback
retention window are tracked in
[the production execution record](docs/cloudflare-production-migration.md).

MyTuums is a social app with posts, replies, likes, follows, profiles, search and
moderation with appeals. This branch runs its backend on Workers with D1 and R2.

This README is about developing it. What the product _does_ is
[docs/product.md](docs/product.md); if you are an AI coding agent, start at
[AGENTS.md](AGENTS.md).

## Stack

| Layer    | Tech                                                                         |
| -------- | ---------------------------------------------------------------------------- |
| Monorepo | pnpm 12 + Turborepo, Node 24, TypeScript strict everywhere                   |
| Web      | React 19, Vite, TanStack Router, Jotai, TanStack Query, Paraglide, shadcn/ui |
| Server   | Cloudflare Worker: auth, RPC, private media and SPA on one origin            |
| API      | oRPC procedures over Drizzle, D1 atomic batches, R2 media                    |
| Auth     | better-auth: password, OAuth, two-factor, passkeys, One Tap                  |
| Data     | D1 (SQLite), Drizzle ORM, committed migrations                               |
| Hosting  | Workers, private EU R2, Stream, Images, Email Service and Workflows          |

## Prerequisites

Docker must be running for the private Cloudflare link-fetcher image build. The
application, database and background jobs use Workers, D1 and Workflows.

- Node 24 (`.nvmrc`) and pnpm 12
- Chromium and its system libraries for browser tests

## Setup

```bash
pnpm install
pnpm build
pnpm db:test:setup
pnpm test:e2e
```

Native tests provision isolated local D1/R2 without Docker, PostgreSQL or cloud
credentials. E2E uses synthetic Access, email and Stream transport and owns ports
`:3101` / `:5273`. It does not prove hosted provider availability.

Run `pnpm dev` for the local app at `http://localhost:5173` and branding at
`http://localhost:5174`. Password accounts, posts, images and captured email use
persistent local D1/R2; no cloud credentials are needed. Open
`http://localhost:3001/__dev/emails` for verification links. See
[operations](docs/operations.md#local-development) for persistence and provider limits.

## Agent browser

Agents use [agent-browser](https://agent-browser.dev/) for local UI inspection
and browser bug reproduction. The discovery skill lives in
`.agents/skills/agent-browser`; usage instructions come from the installed CLI.
Install the machine-level tooling (validated with version 0.37.0):

```bash
npm install -g agent-browser@0.37.0 --allow-scripts=agent-browser
agent-browser install
agent-browser skills get core
```

On Linux, use `agent-browser install --with-deps` if browser libraries are
missing. On Ubuntu, a downloaded Chrome may report "No usable sandbox".
Install official Google Chrome and set `executablePath` to
`/opt/google/chrome/chrome` in `~/.agent-browser/config.json` so it uses
Ubuntu's existing Chrome sandbox policy. Keep this machine-specific path out
of project configuration and keep the browser sandbox enabled.

Use a unique session name for your task and pass it on every command:

```bash
agent-browser --session mytuums-example open http://localhost:5173
agent-browser --session mytuums-example snapshot -i
agent-browser --session mytuums-example screenshot /tmp/mytuums-example.png
agent-browser --session mytuums-example errors
agent-browser --session mytuums-example close
```

Keep the hostname
`localhost` consistent for auth cookies and passkeys. Use development accounts
and non-production data; keep saved auth state and captures in the ignored
`.agent-browser/` directory or outside the repository. Inspect changed flows
with fresh snapshots after page changes. Repeatable regression checks remain
in the existing test suites; see [E2E context](e2e/CONTEXT.md).

## Common commands

`pnpm jobs:dev` starts one maintenance Workflow in the running local development
stack. App and jobs share its D1/R2 state. OAuth, Stream video processing and IGDB
provider checks use hosted preview; the local stack has no provider credentials.

Maintenance commands use local D1/R2 by default. A hosted command must select
preview or production explicitly:

```bash
pnpm games:seed
pnpm games:sync --remote --environment=preview
pnpm --filter @my-tuums/api reconcile:media --remote --environment=production
pnpm --filter @my-tuums/api prune:notifications --retention-days=90
```

Reconciliation deletes unreferenced managed images. Notification pruning is a
dry run unless `--apply` is added. These commands load no `.env` or S3 credentials.

Three levels of validation, widening. Use the narrowest one that can see your
change while you work, and `pnpm verify` before you push.

| Command            | What it does                                                     |
| ------------------ | ---------------------------------------------------------------- |
| `pnpm test:unit`   | Vitest logic/component suites plus native Worker fixtures        |
| `pnpm verify`      | **PR** — build, lint, typecheck, format, docs, unit, integration |
| `pnpm verify:full` | **full** — the above plus the Playwright suite                   |

`pnpm verify` is exactly what CI's `Verify` job runs. See
[operations](docs/operations.md) for deployment and maintenance commands.

| Command                                                         | What it does                                                   |
| --------------------------------------------------------------- | -------------------------------------------------------------- |
| `pnpm build`                                                    | production builds across the workspace                         |
| `pnpm lint` · `pnpm typecheck`                                  | Oxlint, ESLint, and TypeScript across the workspace            |
| `pnpm format`                                                   | Prettier write; checked separately from `pnpm lint`            |
| `pnpm db:test:setup` then `pnpm test:integration`               | API integration suites against ephemeral local D1              |
| `pnpm test:e2e`                                                 | Playwright; slow, own ports (`:3101` / `:5273`)                |
| `pnpm db:generate` · `pnpm db:migrate` · `pnpm db:promote`      | new migration · apply it · appoint the first admin (bootstrap) |
| `pnpm docs:check`                                               | validate the docs against the code                             |
| `pnpm --filter @my-tuums/api exec vitest run src/image.test.ts` | one test file (same shape for web)                             |

The rest of the Drizzle toolbox is package-level:
`pnpm --filter @my-tuums/db db:migrate` · `db:check` ·
`db:generate:auth`.

## Repository layout

`apps/jobs` owns the Cloudflare background runtime; it shares the API's lifecycle
rules and D1 database while running independently of HTTP requests.

| Path            | What lives there                                                                     |
| --------------- | ------------------------------------------------------------------------------------ |
| `apps/web`      | the SPA: file routes in `src/routes`, Jotai state in `src/atoms`, i18n in `messages` |
| `apps/branding` | the public landing site served at `about.mytuums.com`                                |
| `apps/server`   | the native application Worker, Access, HTTP gates and static SPA                     |
| `packages/api`  | oRPC procedures, business rules, moderation, media, rate limiting                    |
| `packages/auth` | the single better-auth instance and its providers, email and hooks                   |
| `packages/db`   | Drizzle schema, committed migrations, test-database guards                           |
| `e2e`           | the Playwright suite                                                                 |
| `docs`          | architecture, product, operations, security                                          |
| `scripts`       | repository tooling (`check-docs.ts`)                                                 |
| `tools/oxlint`  | vendored repository-local Oxlint plugins                                             |

The application and package directories carry their own `CONTEXT.md` files —
the authoritative maps, boundaries, invariants, and verification guidance for
each owned area.

## Conventions

Three rules are not negotiable, and a change that trips one should fix the
code rather than the config:

- **UI is shadcn only** — add components with the shadcn CLI, never another
  component library or a hand-rolled styled primitive.
- **Shared client state is Jotai atoms**, not `useState`/`useEffect`.
- **The strict TypeScript, ESLint, and Oxlint anti-slop configs are deliberate.**

The repository guardrails are in [AGENTS.md](AGENTS.md); their architectural
reasons and owning source files are in [CONTEXT.md](CONTEXT.md).

## Documentation

| Document                                     | Answers                                            |
| -------------------------------------------- | -------------------------------------------------- |
| [AGENTS.md](AGENTS.md)                       | how should an agent work in this repository?       |
| [CONTEXT.md](CONTEXT.md)                     | where does this change go?                         |
| [docs/architecture.md](docs/architecture.md) | how do the pieces fit and what happens at runtime? |
| [docs/product.md](docs/product.md)           | what does the app do, and what do we call it?      |
| [docs/operations.md](docs/operations.md)     | how do I run, deploy and maintain it?              |
| [docs/security.md](docs/security.md)         | what is exposed, and what must not break?          |
| [TESTING_STRATEGY.md](TESTING_STRATEGY.md)   | does this change need a test, and at which layer?  |
| [SECURITY.md](SECURITY.md)                   | how do I report a vulnerability?                   |
