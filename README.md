# MyTuums

This experimental branch implements an isolated Cloudflare-native PoC. Railway
production, `main` and other branches keep their existing deployment paths.
Hosted deployment and complete verification are still outstanding; use
[the migration record](docs/cloudflare-migration.md) for current status.

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

Interactive `pnpm dev` wiring is still incomplete. It starts Vite and low-level
Wrangler, whose real entrypoint requires the PoC host, Access assertion and
secrets. See [operations](docs/operations.md#local-development) before using it.

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

After the interactive local development composition is available, use a unique
session name for your task and pass it on every command:

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

On this experimental branch, `pnpm jobs:dev` starts the local Cloudflare jobs
Worker. It coordinates Stream video processing, game sync and maintenance through
Workflows. It has no HTTP health endpoint and does not require FFmpeg. The app
entrypoint is implemented; the end-to-end development stack is still being ported. Use the
[video operations checks](docs/video-operations.md) for the isolated native runtime.

The PoC maintenance commands use local D1/R2 by default, with `--remote` selecting
only the isolated hosted PoC resources:

```bash
pnpm games:seed --database=mytuums-poc
pnpm --filter @my-tuums/api reconcile:media --bucket=mytuums-poc-media
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

`pnpm verify` is exactly what CI's `Verify` job runs. This Cloudflare PoC branch
is still being ported; see [the migration record](docs/cloudflare-migration.md)
for current checks and the remaining development and hosted deployment work.

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
