# syntax=docker/dockerfile:1
# Build from the monorepo root; this service carries native FFmpeg and no SPA.
FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS pruner
COPY . .
RUN TURBO_VERSION="$(sed -n 's/^  turbo@\([0-9.]*\):$/\1/p' pnpm-lock.yaml | head -n 1)" && \
    test -n "$TURBO_VERSION" && \
    npx -y "turbo@${TURBO_VERSION}" prune @my-tuums/video-worker --docker

FROM base AS builder
RUN apk add --no-cache ffmpeg
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile
COPY --from=pruner /app/out/full/ .
RUN pnpm --filter @my-tuums/video-worker test:media
RUN pnpm --filter @my-tuums/video-worker build

FROM base AS runner
ENV NODE_ENV=production
ENV VIDEO_TEMP_DIRECTORY=/tmp/mytuums-video-worker
RUN apk add --no-cache ffmpeg tini
COPY --from=pruner /app/out/json/ .
RUN pnpm install --prod --frozen-lockfile
COPY --from=builder /app/apps/video-worker/dist ./apps/video-worker/dist
RUN addgroup -S mytuums && adduser -S mytuums -G mytuums
USER mytuums
EXPOSE 3002
# Forward container termination to the native subprocess group and reap children.
ENTRYPOINT ["/sbin/tini", "-g", "--"]
CMD ["node", "apps/video-worker/dist/index.js"]
