# .github context

## Responsibility

CI verifies the Cloudflare application, Workflows and private link-fetcher Container.
After all three checks pass for a push, `main` deploys production and `release/**`
deploys preview through the ordered command in
`packages/db/scripts/deploy-preview.ts`. Pull requests only run verification.

## Start here

| File                     | Owns                                             |
| ------------------------ | ------------------------------------------------ |
| `workflows/ci.yml`       | verification and branch-gated Cloudflare deploys |
| `workflows/opencode.yml` | comment-triggered agent, separate from CI        |
| `../docs/operations.md`  | native build, deployment and test requirements   |

## Change map

- Add repository-wide checks to `../package.json`'s `verify` script.
- Change browser setup in the `e2e` job and `../e2e/CONTEXT.md` together.
- Update an action by resolving its full commit and retaining the version comment.
- Change deployment ordering and branch admission in
  `../packages/db/scripts/deploy-preview.ts`; the workflow only selects the target
  after the required checks pass.

## Invariants

- Every action is pinned to a full commit SHA. Checkout uses
  `persist-credentials: false`; CI needs only `contents: read`.
- `Verify` runs exactly `pnpm verify`, including Worker artifact and native
  Workflow checks. Builds precede lint/typecheck because Vite generates sources.
- `E2E tests` builds the SPA before starting its disposable Worker/D1/R2 stack.
  It uses synthetic Access/mail/Stream providers and never loads bucket secrets.
- All three jobs use the self-hosted runner, Node 24 and the frozen pnpm lockfile.
  Browser system libraries must already be installed on that runner.
- Verification jobs have a 30-minute timeout. Push and pull-request events share
  the head branch concurrency key. Pull requests cancel superseded runs; pushes
  finish because cancellation during migrations or a multi-Worker deployment
  could leave an environment on mixed versions.
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

Run `pnpm verify` and `pnpm test:e2e` locally. Validate workflow YAML and compare
its commands with those scripts. Hosted CI execution remains a separate check
when this branch is pushed; local success does not prove the runner is available.

## Cloudflare deployment

The completed migration is recorded in
[the execution record](../docs/cloudflare-production-migration.md). A successful
push to `main` deploys production; a successful push to `release/**` deploys
preview. The ordered command remains the only deployment implementation and
rechecks the exact commit's required GitHub Actions results before applying D1
migrations and publishing the Worker stack.
