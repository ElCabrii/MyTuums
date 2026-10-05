# .github context

## Responsibility

CI uses a five-minute `Fast checks` job on `release/**` pushes and PRs targeting
branches other than `main`. PRs targeting `main` and pushes to `main` run full
verification, E2E and the private link-fetcher Container build. After the target's
checks pass, `main` deploys production and `release/**` deploys preview through the ordered command in
`packages/db/scripts/deploy-preview.ts`. Pull requests only run verification.

## Start here

| File                     | Owns                                                            |
| ------------------------ | --------------------------------------------------------------- |
| `workflows/ci.yml`       | full verification for main PRs/pushes and production deployment |
| `workflows/ci-fast.yml`  | fast branch verification and preview deployment                 |
| `workflows/opencode.yml` | comment-triggered agent, separate from CI                       |
| `../docs/operations.md`  | native build, deployment and test requirements                  |

## Change map

- Add repository-wide checks to `../package.json`'s `verify` script.
- `verify:fast` keeps build, lint, typecheck, formatting, docs, migration metadata
  and `test:fast`. The latter runs API/auth/db/link-fetcher unit suites and web's
  Node project. DOM, native Worker/Workflow and D1 integration suites stay in full
  verification; no tests are deleted. Keep the shared checks aligned with `verify`.
- Change browser setup in the `e2e` job and `../e2e/CONTEXT.md` together.
- Update an action by resolving its full commit and retaining the version comment.
- Change deployment ordering and branch admission in
  `../packages/db/scripts/deploy-preview.ts`; the workflow only selects the target
  after the required checks pass.

## Invariants

- Every action is pinned to a full commit SHA. Checkout uses
  `persist-credentials: false`; CI needs only `contents: read` and `checks: read`.
- `Verify` runs exactly `pnpm verify`, including Worker artifact and native
  Workflow checks. Builds precede lint/typecheck because Vite generates sources.
- Branch filters select the two workflows. Do not replace these filters with
  skipped jobs sharing the required check names: a newer skipped result on the
  same commit would supersede a successful deployment check.
- `E2E tests` builds the SPA before starting its disposable Worker/D1/R2 stack.
  It uses synthetic Access/mail/Stream providers and never loads bucket secrets.
- All verification jobs use the self-hosted runner, Node 24 and the frozen pnpm lockfile.
  Browser system libraries must already be installed on that runner.
- `Fast checks` has a five-minute timeout, including checkout and dependency
  setup. Full verification jobs have a 30-minute timeout. Runner queue time and
  deployment are outside the fast-check budget; a timeout fails the check and
  blocks preview deployment. Confirm successful timings on the actual runner.
  Workflow concurrency is scoped by
  event type and PR number or branch name. New commits cancel older runs of the
  same PR without cancelling a push run. Active pushes finish because cancellation
  during migrations or a multi-Worker deployment could leave an environment on
  mixed versions; newer pushes to the same branch wait for the active run.
  `TMPDIR` uses the runner-owned temporary directory, avoiding the host
  `/tmp` quota that previously caused SQLite write failures during badge tests.
  Turbo explicitly passes `TMPDIR` through its strict environment filter; setting
  it only on the workflow step does not reach nested Worker tests. Playwright reports survive test failure and expire after seven days.
- `Docker image builds` builds the private Cloudflare link-fetcher Container
  and checks that its non-root user can read the generated bundle. It preserves
  main's existing required check without restoring the removed Node app/video
  images or PostgreSQL services. Branch protection remains unchanged.
- The comment-triggered `opencode` workflow retains its own authorization and
  provider configuration; it is not part of native CI migration.
- Production and preview deployments have separate concurrency groups. Different
  release branches therefore serialize writes to the one preview environment.
  The deploy jobs use the repository's `CLOUDFLARE_API_TOKEN` secret and public
  `VITE_GOOGLE_CLIENT_ID` variable. Runtime Worker secrets stay in Cloudflare.

## Verification

Run `pnpm verify:fast`, `pnpm verify` and `pnpm test:e2e` locally as appropriate. Validate workflow YAML and compare
its commands with those scripts. Hosted CI execution remains a separate check
when this branch is pushed; local success does not prove the runner is available.

## Cloudflare deployment

The completed migration is recorded in
[the execution record](../docs/cloudflare-production-migration.md). A successful
push to `main` deploys production; a successful push to `release/**` deploys
preview. The ordered command remains the only deployment implementation and
rechecks the exact commit's required GitHub Actions results before applying D1
migrations and publishing the Worker stack. Preview requires `Fast checks`;
production requires `Verify`, `E2E tests` and `Docker image builds`. Skipped,
cancelled, missing or failed checks never satisfy either deployment gate.
