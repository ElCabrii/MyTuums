# Testing strategy

What MyTuums tests, where, and how to decide whether a new test should exist.

The goal is not coverage. It is **confidence per unit of maintenance cost and
feedback time**. A suite developers trust and run is worth more than a larger
one they skip.

## The three levels

| Level    | Command            | Needs                       | Use it                                                 |
| -------- | ------------------ | --------------------------- | ------------------------------------------------------ |
| **fast** | `pnpm test:unit`   | nothing                     | while editing                                          |
| **PR**   | `pnpm verify`      | Postgres (`pnpm docker:up`) | before you call the work done                          |
| **full** | `pnpm verify:full` | Postgres, ideally a bucket  | before a release, or when a change crosses the browser |

`pnpm verify` is byte-for-byte what CI's `Verify` job runs. Narrower still
while iterating: `pnpm --filter @my-tuums/web exec vitest run src/atoms/like.test.ts`.

## Critical behaviours

These are what the suite exists for. If a change puts one of them at risk, it
needs a test; if a test does not defend one of them (or something like them),
it probably should not exist.

1. **Authorization and the moderation hierarchy.** Nobody acts at or above
   their own rank; nobody acts on themselves; `/api/auth/admin/*` stays 404'd
   so `/rpc` is the only path to a moderation action.
2. **The audit log is append-only and truthful.** Every effect reads its guard
   `FOR UPDATE`; concurrent inverse actions log exactly one row and send
   exactly one email; a rollback leaves no row, no state change and no mail.
3. **Appeals cannot be replayed or aimed at a superseded action.**
4. **Media authorization.** A viewer can resolve a display object they are
   allowed to see and never someone else's untouched original; blocks and bans
   remove access; `/media` demands a session before it parses a key.
5. **Uploads cannot carry script.** Types are sniffed from bytes, not trusted
   from the declaration; SVG is refused on both sides.
6. **Session and page gates.** A signed-out visitor is redirected with their
   destination preserved and never into a loop; the gate fails open on a
   database blip rather than mass-signing-out.
7. **Onboarding and legal consent gates** hold every procedure, including
   accounts that arrived through OAuth with nothing to gate on.
8. **Request-body caps** are enforced before oRPC buffers, for declared and
   chunked framing alike, with the signed-out appeal surface keeping its own
   lower ceiling.
9. **No open redirects** out of `?redirect=`.
10. **The privacy projection.** No email address reaches a rendered page or an
    RPC response.
11. **The production artefact boots.** The image serves the SPA, answers
    `/health` against a real database, redirects the page gate, and registers
    exactly the OAuth providers the bundle offers.

## Target architecture

Derived from this codebase's risk profile, not from a pyramid ratio.

### Unit — `*.test.ts(x)`, no I/O

**Where the rules live.** Pure logic, state transitions, parsing and encoding
edge cases we own, Jotai atoms, and component behaviour that is observable
through the accessibility tree.

In `apps/web` the file's extension is its environment declaration, enforced by
two Vitest projects: `*.test.ts` runs under Node (`test:node`), `*.test.tsx`
under jsdom, and the rare non-React test that genuinely owns document
behaviour (canvas, `document.head`, `window.location`) is named
`*.dom.test.ts` to join the jsdom project. A `.test.ts` that reaches for a
browser API fails loudly instead of silently gaining jsdom — and Node's setup
provides no `window`, so production code that starts depending on browser
globals cannot hide behind the test environment. When a rendered behaviour is
already owned by the atom/helper underneath it, the component test only proves
its wiring (see `paginated-state.test.tsx` vs its consumers).

Must pass with **no database reachable**. This is structural, not a
convention: `packages/api/vitest.config.ts` and `packages/auth/vitest.config.ts`
blank `DATABASE_URL` for their unit projects, so a unit test that grows a
database dependency fails immediately and by name — on a developer's machine
as well as in CI.

`apps/server`'s tests belong here too: they drive the real request handler
against socket stubs, which is where the routing order, the body caps, the page
gate and the security headers are pinned.

### Integration — `*.int.test.ts` in `packages/api`

**Where the boundary lives.** Real Postgres, the real Better Auth instance,
the real oRPC procedures. Reach for it when the property _is_ the boundary:
transactions, `FOR UPDATE` guards, keyset pagination, visibility predicates,
cascades, rate-limit tiers, the auth database hooks.

Do not re-enumerate domain edge cases here that a unit test already owns.

Object storage is the one boundary deliberately faked (`testStorage` in the
harness): it is outside the truncate helper's control, costs money, and
"the row points at the object we wrote" needs no bucket.

### Contract — `e2e/tests/api/*`

**Where the wire lives.** No browser, no auth state, runs in about a second
and a half for the whole project: security headers, CSP, CORS, the oRPC error
envelope, rate limiting, the media and page gates over real HTTP.

This is the cheapest layer that can see the assembled server. Prefer it over a
browser spec whenever the assertion is about a response rather than a screen.

### End-to-end — `e2e/tests/specs/*`

**Deliberately scarce.** A browser journey earns its place only when the thing
being proved genuinely crosses the browser: a real WebAuthn ceremony, a real
TOTP challenge round trip, a canvas re-encode landing in a bucket, an
optimistic cache surviving a navigation, a CSS composition at a real viewport
width, or an axe scan.

What is currently there and why it is there:

| Spec                                                                                     | Why no cheaper layer can do it                                             |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `auth`, `welcome`, `legal-consent`, `email-verification`, `password-reset`               | the gates compose across navigations and real redirects                    |
| `two-factor`                                                                             | a real WebAuthn authenticator and a live TOTP round trip                   |
| `compose`, `thread`, `like`, `repost`, `bookmark`, `follow`, `feed`, `search`, `profile` | optimistic cache patches, ordering and layout in a real browser            |
| `notifications`                                                                          | the unread badge and mark-read journey across two live sessions            |
| `settings`                                                                               | a canvas re-encode reaching a real bucket and coming back through `/media` |
| `moderation`                                                                             | report → queue → remove → appeal across two signed-in people               |
| `a11y`, `csp`, `i18n`, `theme`                                                           | properties of a rendered document                                          |

### The image job

The only place the production artefact is ever started. It exists because two
production breakages reached users through a fully green pipeline, and neither
was reachable without building the image.

## When does a test deserve to exist?

Write it if it protects at least one of these:

- a critical business invariant;
- a public API or externally observable contract;
- an important integration boundary;
- a security, authorization, concurrency, transactional or data-integrity
  property;
- a regression that actually happened and could plausibly happen again;
- domain logic complex enough that several plausible implementations are wrong;
- a critical user journey no cheaper layer can establish.

Do **not** write it because it raises coverage, exercises a line, tests a
method, or completes a checklist.

Before writing, ask: **"if I subtly broke this behaviour, would an important
test fail?"** If an existing one would, you are about to write a duplicate.

## Rules for coding agents

Short on purpose. Follow them.

- Do not add a test for every new function. Add one when a listed protection
  applies.
- Do not optimise for coverage percentage. There is no target and there will
  not be one.
- Test externally observable behaviour, not private helpers, call order, or
  intermediate state.
- Prefer regression tests for bugs that actually happened. Name the issue in
  the test name or a comment.
- Prefer the smallest test that can catch the failure. When fixing a bug, first
  find the cheapest reliable level at which the regression reproduces.
- Do not duplicate an assertion across layers. If the rule is already pinned in
  `packages/auth/src/rules.ts`'s tests, do not re-prove it through a browser.
- Do not mock something merely because mocking is easy. Test the real boundary
  where the boundary is the point.
- Do not add an E2E test when a narrow integration or `e2e/tests/api` test gives
  the same confidence.
- Do not add snapshot tests for structured behaviour that can be asserted
  explicitly.
- Do not add a fixture or factory until repeated setup genuinely justifies it.
  Test code must stay simpler than the production code it guards.
- Do not fix a flaky test with a retry. Fix the source, or quarantine it
  explicitly with a comment saying why.
- Run the smallest relevant test set while iterating; run `pnpm verify` before
  declaring the work complete.
- For a critical user-facing change, verify the real behaviour end to end when
  the environment permits it.

### Fixtures in `packages/api`

`createTestUser` mints an account and a session through
`@my-tuums/auth/testing`, which costs about 95ms. `createPasswordTestUser`
goes through production sign-up and sign-in and costs about 430ms — two scrypt
hashes. Use the second **only** when a password being accepted or refused is
the assertion; there are currently two such tests. Everywhere else the account
is a premise, and `auth.int.test.ts` is where sign-up itself is under test.

## Further reading

- [.github/CONTEXT.md](.github/CONTEXT.md) — the CI jobs and their invariants.
- [CONTEXT.md](CONTEXT.md#verification-matrix) — the verification matrix.
