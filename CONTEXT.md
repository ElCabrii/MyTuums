# Repository context

The repository map for MyTuums. Use the routing table to reach the context that
owns a change; use `docs/` for cross-package architecture, product behavior,
operations, and security.

## Repository

MyTuums — a Twitter-style social app (posts, replies, likes, follows,
profiles, moderation) with real authentication. pnpm 10 + Turborepo on Node
22, TypeScript strict everywhere.

| Workspace       | Package            | Owns                                               |
| --------------- | ------------------ | -------------------------------------------------- |
| `apps/web`      | `@my-tuums/web`    | React 19 + Vite SPA, TanStack Router, Jotai        |
| `apps/server`   | `@my-tuums/server` | `node:http` server, the only deployed process      |
| `packages/api`  | `@my-tuums/api`    | oRPC procedures, business rules, media, moderation |
| `packages/auth` | `@my-tuums/auth`   | the single better-auth instance                    |
| `packages/db`   | `@my-tuums/db`     | Drizzle schema, migrations, test-database guards   |
| `e2e`           | `@my-tuums/e2e`    | Playwright journeys over the real stack            |

## Context routing

| If the change is about                                    | Go to                                                |
| --------------------------------------------------------- | ---------------------------------------------------- |
| UI, routes, client state, i18n copy, theme                | [apps/web/CONTEXT.md](apps/web/CONTEXT.md)           |
| HTTP routing, env validation, headers, runtime, Docker    | [apps/server/CONTEXT.md](apps/server/CONTEXT.md)     |
| Business rules, RPC procedures, moderation, media/storage | [packages/api/CONTEXT.md](packages/api/CONTEXT.md)   |
| Sign-in, OAuth providers, sessions, auth email            | [packages/auth/CONTEXT.md](packages/auth/CONTEXT.md) |
| Schema, migrations, test databases                        | [packages/db/CONTEXT.md](packages/db/CONTEXT.md)     |
| End-to-end journeys                                       | [e2e/CONTEXT.md](e2e/CONTEXT.md)                     |
| Workflows, CI jobs                                        | [.github/CONTEXT.md](.github/CONTEXT.md)             |
| Repository lint and TypeScript tooling                    | root configs, `package.json`, `tools/oxlint/`        |

Cross-package questions — how the pieces fit, what a request does end to end —
are answered in [docs/architecture.md](docs/architecture.md).

## Cross-cutting invariants

Only invariants that span packages live here. Package-local invariants belong
to the owning context.

- **One origin in production.** The server serves the built SPA, because
  `apps/web/src/lib/orpc.ts` resolves `/rpc` against `window.location.origin`
  and uploaded images are stored as relative `/media/` paths. Split them
  across origins and RPC and every image break together.
- **`SIGNED_OUT_PATHS` has exactly one definition.** `packages/api/src/constants.ts`
  owns it; the server's page gate and the client's `useRequireSignedIn` both
  read it. Duplicating it lets the two gates disagree and bounce a visitor
  between them forever.
- **The browser-safe subpaths stay dependency-free.**
  `@my-tuums/api/constants`, `@my-tuums/api/dimensions`, `@my-tuums/api/roles`
  and `@my-tuums/auth/rules` must never import `@my-tuums/db`; the web app
  imports them, and a database import throws at module load in a browser.
  Those four are the _only_ workspace modules in the SPA bundle, and they are
  the only ones `apps/web` may import from either package.
- **Auth-owned user fields are written through the auth client only.**
  `packages/auth`'s database hooks are the single enforcement point for
  user-field rules; an oRPC procedure writing them bypasses validation.
- **The client's provider list and the server's credentials must agree.**
  `VITE_SOCIAL_PROVIDERS` is baked into the bundle at build time and the
  browser cannot see server env. CI asserts both halves.
- **Rate limiting is not uniform.** Most policies key on `user:<id>`; the
  signed-out appeal path keys on the capability the caller presented. See
  [docs/security.md](docs/security.md).
- **Destructive database helpers refuse any database not ending in `_test`.**
- **Migrations run as a pre-deploy step, never at server boot.** N replicas
  would race the same DDL.
- **The account rules have exactly one definition.**
  `packages/auth/src/rules.ts` (`@my-tuums/auth/rules`) owns the handle bounds
  and charset, the date-of-birth parse and age comparison, the bio limit, the
  preference lists, and every English rejection string. The browser forms, the
  better-auth hooks and plugin config, and `usernameInput` in
  `packages/api/src/users.ts` all read it. Those strings are also the keys of
  `apps/web/src/lib/auth-error-message.ts`; restate one anywhere and server
  rejections render untranslated.

## Generated files

These artifacts are generator-owned. Run the generator and commit its output
(or nothing where the artifact is git-ignored).

| Artefact                         | Produced by                                           |
| -------------------------------- | ----------------------------------------------------- |
| `apps/web/src/routeTree.gen.ts`  | the TanStack Router Vite plugin (git-ignored)         |
| `apps/web/src/paraglide`         | `pnpm --filter @my-tuums/web paraglide` (git-ignored) |
| `packages/db/src/schema/auth.ts` | `pnpm --filter @my-tuums/db db:generate:auth`         |
| `packages/db/drizzle`            | `pnpm db:generate` (committed, shipped in the image)  |

The two git-ignored web artefacts are why `lint` and `typecheck` depend on
`build` in `turbo.json`: `tsc` cannot resolve a route target or a message
function until one build has run.

## Verification matrix

| Change touches                  | Run                                                    |
| ------------------------------- | ------------------------------------------------------ |
| anything                        | `pnpm lint`, `pnpm typecheck`                          |
| pure logic, atoms, components   | `pnpm test:unit`                                       |
| procedures, queries, schema     | `pnpm db:test:setup` then `pnpm test:integration`      |
| a user journey                  | `pnpm test:e2e` (slow; use only for end-to-end proof)  |
| the Dockerfile or the SPA build | `pnpm build`, and let CI's `docker` job boot the image |
| documentation                   | `pnpm docs:check`                                      |

`.env` must exist first — copy `.env.example`. Integration tests need a
reachable Postgres (`pnpm docker:up`).

## Further reading

- [README.md](README.md) — human setup and commands.
- [docs/architecture.md](docs/architecture.md) — boundaries and executable flows.
- [docs/product.md](docs/product.md) — implemented behaviour and vocabulary.
- [docs/operations.md](docs/operations.md) — environments, deploys, CI.
- [docs/security.md](docs/security.md) — trust boundaries and sensitive invariants.
