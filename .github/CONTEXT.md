# .github context

## Responsibility

This branch's CI verifies the Cloudflare-native PoC. It never deploys and needs
no provider credentials. Production Railway configuration and required checks on
`main` are outside this branch's changes.

## Start here

| File                     | Owns                                             |
| ------------------------ | ------------------------------------------------ |
| `workflows/ci.yml`       | `Verify`, `E2E tests`, and `Docker image builds` |
| `workflows/opencode.yml` | comment-triggered agent, separate from CI        |
| `../docs/operations.md`  | native build, deployment and test requirements   |

## Change map

- Add repository-wide checks to `../package.json`'s `verify` script.
- Change browser setup in the `e2e` job and `../e2e/CONTEXT.md` together.
- Update an action by resolving its full commit and retaining the version comment.
- Deployment belongs to branch-specific Workers Builds, not this workflow.

## Invariants

- Every action is pinned to a full commit SHA. Checkout uses
  `persist-credentials: false`; CI needs only `contents: read`.
- `Verify` runs exactly `pnpm verify`, including Worker artifact and native
  Workflow checks. Builds precede lint/typecheck because Vite generates sources.
- `E2E tests` builds the SPA before starting its disposable Worker/D1/R2 stack.
  It uses synthetic Access/mail/Stream providers and never loads bucket secrets.
- All three jobs use the self-hosted runner, Node 24 and the frozen pnpm lockfile.
  Browser system libraries must already be installed on that runner.
- Each job has a 30-minute timeout. Push and pull-request events share the head
  branch concurrency key, so duplicate runs cannot occupy the runner queue.
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

## Verification

Run `pnpm verify` and `pnpm test:e2e` locally. Validate workflow YAML and compare
its commands with those scripts. Hosted CI execution remains a separate check
when this branch is pushed; local success does not prove the runner is available.

## Authorized production migration

Migration changes on `codex/cloudflare-production` run through the pull-request
trigger only. Do not also trigger pushes for that branch: GitHub can treat the
cancelled duplicate push checks as unmet required checks even after PR CI passes. The verified integration may
merge into main under the production migration authorization, with all three
existing required checks retained. Source disconnection, main
merge and final production deployment remain gated by candidate validation; see
[the execution record](../docs/cloudflare-production-migration.md).
