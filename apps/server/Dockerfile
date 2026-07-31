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
# Build context is the monorepo root (see docker-compose.yml:
# `build.context: .`), because `turbo prune` needs the whole workspace to
# compute the pruned subset for @my-tuums/server.

FROM node:22-alpine AS base
RUN corepack enable

# ---- Prune the monorepo down to what @my-tuums/server needs to build ----
FROM base AS pruner
WORKDIR /app
COPY . .
RUN npx -y turbo@^2 prune @my-tuums/server --docker

# ---- Install full (dev+prod) deps and build the pruned subset ----
FROM base AS builder
WORKDIR /app
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile
COPY --from=pruner /app/out/full/ .
RUN pnpm --filter @my-tuums/server run build

# ---- Production image: prod-only deps + the pre-built bundle ----
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=pruner /app/out/json/ .
RUN pnpm install --prod --frozen-lockfile
COPY --from=builder /app/apps/server/dist ./apps/server/dist

# Not running as root in the final image.
RUN addgroup -S mytuums && adduser -S mytuums -G mytuums
USER mytuums

EXPOSE 3001
CMD ["node", "apps/server/dist/index.js"]
