# MyTuums

A Twitter-style social app — posts, replies, likes, follows, profiles, search,
and a full moderation system with appeals. React 19 + Vite SPA, Node 24 + oRPC
API, Postgres + Drizzle, deployed on Railway in the EU.

This README is about developing it. What the product _does_ is
[docs/product.md](docs/product.md); if you are an AI coding agent, start at
[AGENTS.md](AGENTS.md).

## Stack

| Layer    | Tech                                                                         |
| -------- | ---------------------------------------------------------------------------- |
| Monorepo | pnpm 12 + Turborepo, Node 24, TypeScript strict everywhere                   |
| Web      | React 19, Vite, TanStack Router, Jotai, TanStack Query, Paraglide, shadcn/ui |
| Server   | `node:http`, no framework — auth, RPC, media and the SPA on one origin       |
| API      | oRPC procedures over Drizzle, keyset pagination, S3 presigned uploads        |
| Auth     | better-auth: password, OAuth, two-factor, passkeys, One Tap                  |
| Data     | Postgres 16, Drizzle ORM, committed migrations                               |
| Hosting  | Railway (EU), Docker image built from `apps/server/Dockerfile`               |

## Prerequisites

- Node 24 (`.nvmrc`) and pnpm 12
- Docker, for Postgres and for running the production image locally

## Setup

```bash
cp .env.example .env      # the single source of env for every host-side process
pnpm install
pnpm docker:up            # Postgres :5432 + the server image :3001, migrations applied first
```

Then either keep the Docker stack, or stop it and develop host-side:

```bash
pnpm dev                  # API :3001, Vite :5173
```

`pnpm dev` and `pnpm docker:up` both want ports 3001 and 5173 — run one, not
both. `.env.example` explains every variable and what happens when it is
unset; the traps worth knowing are collected in
[docs/operations.md](docs/operations.md).

## Common commands

Three levels of validation, widening. Use the narrowest one that can see your
change while you work, and `pnpm verify` before you push.

| Command            | What it does                                                     |
| ------------------ | ---------------------------------------------------------------- |
| `pnpm test:unit`   | **fast** — vitest unit suites, no database needed, ~30s          |
| `pnpm verify`      | **PR** — build, lint, typecheck, format, docs, unit, integration |
| `pnpm verify:full` | **full** — the above plus the Playwright suite                   |

`pnpm verify` is exactly what CI's `Verify` job runs. It needs a reachable
Postgres (`pnpm docker:up`).

| Command                                                         | What it does                                                   |
| --------------------------------------------------------------- | -------------------------------------------------------------- |
| `pnpm build`                                                    | production builds across the workspace                         |
| `pnpm lint` · `pnpm typecheck`                                  | Oxlint, ESLint, and TypeScript across the workspace            |
| `pnpm format`                                                   | Prettier write; checked separately from `pnpm lint`            |
| `pnpm db:test:setup` then `pnpm test:integration`               | API integration suites against real Postgres                   |
| `pnpm test:e2e`                                                 | Playwright; slow, own ports (`:3101` / `:5273`)                |
| `pnpm db:generate` · `pnpm db:push` · `pnpm db:promote`         | new migration · apply it · appoint the first admin (bootstrap) |
| `pnpm docs:check`                                               | validate the docs against the code                             |
| `pnpm docker:up` · `pnpm docker:down`                           | the full local stack                                           |
| `pnpm --filter @my-tuums/api exec vitest run src/image.test.ts` | one test file (same shape for web)                             |

The rest of the Drizzle toolbox is package-level:
`pnpm --filter @my-tuums/db db:migrate` · `db:check` · `db:studio` ·
`db:generate:auth`.

## Repository layout

| Path            | What lives there                                                                     |
| --------------- | ------------------------------------------------------------------------------------ |
| `apps/web`      | the SPA: file routes in `src/routes`, Jotai state in `src/atoms`, i18n in `messages` |
| `apps/branding` | the public landing site served at `about.gabrieldebure.com`                          |
| `apps/server`   | the HTTP server: routing tree, env validation, static SPA, Dockerfile                |
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
