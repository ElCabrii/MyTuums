# AGENTS.md — root router

The compact entry point for an agent working anywhere in this repository. It
routes; it does not explain. Detail lives in the subtree guide that owns the
code, or in `docs/`.

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

## Non-negotiable rules

These are user-set. Do not weaken them to make a check pass.

- **UI: shadcn only.** Use the configured preset (`apps/web/components.json`
  — style base-maia, zinc, lucide). Add components with
  `pnpm --filter @my-tuums/web exec shadcn add <component>`. Never another
  component library, never a hand-rolled styled primitive, never an edit
  inside `apps/web/src/components/ui`.
- **State: Jotai atoms, not hooks.** Client state lives in
  `apps/web/src/atoms`; server state goes through `jotai-tanstack-query`
  atoms. Reach for `useState`/`useEffect` only when there is no atom-shaped
  way.
- **Strict TypeScript and ESLint are deliberate.** Fix the code, never the
  config. The typed promise rules in `eslint.config.mjs` exist because they
  caught real bugs.
- **E2E is slow — do not run it casually.** Prefer `pnpm test:unit` and
  `pnpm test:integration`; CI runs Playwright on every push anyway.
- **Never point non-production tooling at the production bucket.** The E2E
  cleanup deletes objects by prefix.

## Task routing

| If the change is about                                    | Go to                                              |
| --------------------------------------------------------- | -------------------------------------------------- |
| UI, routes, client state, i18n copy, theme                | [apps/web/AGENTS.md](apps/web/AGENTS.md)           |
| HTTP routing, env validation, headers, runtime, Docker    | [apps/server/AGENTS.md](apps/server/AGENTS.md)     |
| Business rules, RPC procedures, moderation, media/storage | [packages/api/AGENTS.md](packages/api/AGENTS.md)   |
| Sign-in, OAuth providers, sessions, auth email            | [packages/auth/AGENTS.md](packages/auth/AGENTS.md) |
| Schema, migrations, test databases                        | [packages/db/AGENTS.md](packages/db/AGENTS.md)     |
| End-to-end journeys                                       | [e2e/AGENTS.md](e2e/AGENTS.md)                     |
| Workflows, CI jobs, the production probe                  | [.github/AGENTS.md](.github/AGENTS.md)             |

Cross-package questions — how the pieces fit, what a request does end to end —
are answered in [docs/architecture.md](docs/architecture.md).

## Cross-cutting invariants

Only rules that span packages live here. Package-local invariants belong to
the subtree guide.

- **One origin in production.** The server serves the built SPA, because
  `apps/web/src/lib/orpc.ts` resolves `/rpc` against `window.location.origin`
  and uploaded images are stored as relative `/media/` paths. Split them
  across origins and RPC and every image break together.
- **`SIGNED_OUT_PATHS` has exactly one definition.** `packages/api/src/constants.ts`
  owns it; the server's page gate and the client's `useRequireSignedIn` both
  read it. Duplicating it lets the two gates disagree and bounce a visitor
  between them forever.
- **The browser-safe subpaths stay dependency-free.**
  `@my-tuums/api/constants`, `@my-tuums/api/dimensions` and
  `@my-tuums/auth/rules` must never import `@my-tuums/db`; the web app imports
  them, and a database import throws at module load in a browser. Those three
  are the *only* workspace modules in the SPA bundle, and they are the only
  ones `apps/web` may import from either package.
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

Never hand-edit these. Run the generator, commit what it produces (or nothing,
where the file is git-ignored).

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
| a user journey                  | `pnpm test:e2e` (slow — see the rule above)            |
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
