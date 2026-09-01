# syntax=docker/dockerfile:1
#
# Multi-stage build for @my-tuums/server.
#
# apps/server is bundled with tsup (see apps/server/tsup.config.ts), which
# inlines the source-only workspace packages (`@my-tuums/{api,auth,db}`) into
# a single dist/index.js — Node's native TS type-stripping does not rewrite
# the `.js` specifiers those packages ship, so importing the unbundled
# source directly (the naive approach) fails at runtime. Only the packages
# apps/server itself declares in `dependencies` (better-auth, @orpc/server,
# zod, @sentry/node, @opentelemetry/core) stay external; everything else
# tsup reaches - including the transitive
# npm deps of the inlined workspace packages, such as drizzle-orm and postgres
# - is bundled into dist/ (grep the external `from "..."` imports in
# dist/index.js to re-verify). The runner therefore needs nothing more than
# those declared dependencies installed.
#
# The image also carries the BUILT WEB APP and serves it from the same origin
# as the API (see apps/server/src/static-files.ts). That is a requirement, not
# a packaging preference: apps/web/src/lib/orpc.ts resolves /rpc against
# window.location.origin, and uploaded avatars are stored as relative /media/
# paths — split the two across origins and RPC and every image break together.
#
# Build context is the monorepo root (see docker-compose.yml:
# `build.context: .`), because `turbo prune` needs the whole workspace to
# compute the pruned subset.

FROM node:24-alpine AS base
RUN corepack enable

# ---- Prune the monorepo down to what @my-tuums/server needs to build ----
FROM base AS pruner
WORKDIR /app
COPY . .
# All three workspaces, since this image builds and ships the app, the
# branding site and the server. The second, server-only prune feeds the runner
# stage: `pnpm install --prod` over the all-workspaces prune would install
# apps/web's and apps/branding's entire production dependency trees (react,
# jotai, shadcn, lucide-react, ...) into an image whose process never imports
# any of it — Vite already bundled both sites into their dist/ at build time.
# Pruning to @my-tuums/server alone keeps the web trees out of the runtime
# image structurally, not by install-time luck.
RUN npx -y turbo@^2 prune @my-tuums/server @my-tuums/web @my-tuums/branding --docker && \
    npx -y turbo@^2 prune @my-tuums/server --docker --out-dir out-runner

# ---- Install full (dev+prod) deps and build the pruned subset ----
FROM base AS builder
WORKDIR /app
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile
COPY --from=pruner /app/out/full/ .
RUN pnpm --filter @my-tuums/server run build
# `vite build` runs the Paraglide and TanStack Router plugins, so the compiled
# messages and the route tree are generated here rather than committed.
#
# Vite bakes every `import.meta.env.VITE_*` into the bundle AT BUILD TIME, and
# Railway only makes service variables visible to a Docker build when the
# Dockerfile declares them with ARG in the stage that needs them — so these two
# are the app's only VITE_* reads (grep `import.meta.env.VITE_` in apps/web/src)
# and they must be listed here or the OAuth buttons and One Tap silently never
# render in production while working fine in dev.
ARG VITE_SOCIAL_PROVIDERS
ARG VITE_GOOGLE_CLIENT_ID
# The self-hosted CI Docker VM has about 956 MiB available. Node derives an
# old-space ceiling near 475 MiB from that limit, but Vite's source-map render
# exhausted even a 580 MiB ceiling after transforming every module.
# Scope the measured ceilings to this build only via NODE_OPTIONS, rather than
# a global ENV: production source maps stay intact without consuming the whole
# VM, while the runtime server keeps Node's ordinary container-aware limits.
#
# The default is a measured figure for THAT VM, so it is an ARG: constrained
# builders can pass --build-arg WEB_BUILD_NODE_OPTIONS=... with their own
# figure (CI builds without one and gets this default; see
# .github/workflows/ci.yml), while a builder with room to spare passes an
# empty string and gets Node's ordinary container-aware default.
ARG WEB_BUILD_NODE_OPTIONS="--max-old-space-size=640 --max-semi-space-size=4"
RUN NODE_OPTIONS="$WEB_BUILD_NODE_OPTIONS" pnpm --filter @my-tuums/web run build
# The branding site (home.mytuums.com): a second, much smaller Vite build with
# no VITE_* reads, so it needs no ARGs of its own. Same NODE_OPTIONS scope for
# consistency, even though its bundle is a fraction of the SPA's.
RUN NODE_OPTIONS="$WEB_BUILD_NODE_OPTIONS" pnpm --filter @my-tuums/branding run build

# ---- Production image: prod-only deps + the pre-built bundle ----
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
# The server-only pruned tree: apps/web is not even a workspace member here,
# so this install cannot pull a single web dependency (see the second prune
# in the pruner stage).
COPY --from=pruner /app/out-runner/json/ .
RUN pnpm install --prod --frozen-lockfile
COPY --from=builder /app/apps/server/dist ./apps/server/dist
COPY --from=builder /app/apps/web/dist ./apps/web/dist
COPY --from=builder /app/apps/branding/dist ./apps/branding/dist
# The generated SQL, for the pre-deploy migration step (apps/server/src/
# migrate.ts). Only the `drizzle/` output is needed — `drizzle-kit` itself is a
# dev dependency and deliberately does NOT ship: `drizzle-orm`, which is already
# a production dependency, applies the same files against the same bookkeeping
# table.
COPY --from=builder /app/packages/db/drizzle ./packages/db/drizzle
# Where ./src/static-files.ts looks. Absolute, because the process's working
# directory is not something this image should depend on.
ENV WEB_DIST=/app/apps/web/dist
# Where the branding-host branch of ./src/request-handler.ts looks (see
# ./src/branding-host.ts).
ENV BRANDING_DIST=/app/apps/branding/dist

# Not running as root in the final image.
RUN addgroup -S mytuums && adduser -S mytuums -G mytuums
USER mytuums

EXPOSE 3001
CMD ["node", "apps/server/dist/index.js"]
