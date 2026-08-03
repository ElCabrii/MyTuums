# syntax=docker/dockerfile:1
#
# Multi-stage build for @my-tuums/server.
#
# apps/server is bundled with tsup (see apps/server/tsup.config.ts), which
# inlines the source-only workspace packages (`@my-tuums/{api,auth,db}`) into
# a single dist/index.js — Node's native TS type-stripping does not rewrite
# the `.js` specifiers those packages ship, so importing the unbundled
# source directly (the naive approach) fails at runtime. Real npm
# dependencies (better-auth, @orpc/server, drizzle-orm, postgres, zod, ...)
# stay external and are installed normally in the `runner` stage below.
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

FROM node:22-alpine AS base
RUN corepack enable

# ---- Prune the monorepo down to what @my-tuums/server needs to build ----
FROM base AS pruner
WORKDIR /app
COPY . .
# Both workspaces, since this image builds and ships both halves.
RUN npx -y turbo@^2 prune @my-tuums/server @my-tuums/web --docker

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
RUN pnpm --filter @my-tuums/web run build

# ---- Production image: prod-only deps + the pre-built bundle ----
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=pruner /app/out/json/ .
RUN pnpm install --prod --frozen-lockfile
COPY --from=builder /app/apps/server/dist ./apps/server/dist
COPY --from=builder /app/apps/web/dist ./apps/web/dist
# The generated SQL, for the pre-deploy migration step (apps/server/src/
# migrate.ts). Only the `drizzle/` output is needed — `drizzle-kit` itself is a
# dev dependency and deliberately does NOT ship: `drizzle-orm`, which is already
# a production dependency, applies the same files against the same bookkeeping
# table.
COPY --from=builder /app/packages/db/drizzle ./packages/db/drizzle
# Where ./src/static-files.ts looks. Absolute, because the process's working
# directory is not something this image should depend on.
ENV WEB_DIST=/app/apps/web/dist

# Not running as root in the final image.
RUN addgroup -S mytuums && adduser -S mytuums -G mytuums
USER mytuums

EXPOSE 3001
CMD ["node", "apps/server/dist/index.js"]
