# syntax=docker/dockerfile:1

# Build: TypeScript and the native Opus encoder (@discordjs/opus compiles with node-gyp).
FROM node:24-bookworm-slim@sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530 AS build
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# Run: Debian's ffmpeg, dynamically linked, so it resolves host names through glibc
# (the static ffmpeg builds can't: Elite-Music's failed on host.docker.internal).
FROM node:24-bookworm-slim@sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ARG GIT_SHA=dev
ENV NODE_ENV=production PLEXBOT_VERSION=$GIT_SHA
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist/src ./dist/src
# The image's own unprivileged user (uid 1000).
USER node
# The bot touches this file every 20 s while its Discord gateway is ready (src/index.ts).
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD ["node", "-e", "process.exit(Date.now() - require('fs').statSync('/tmp/plexbot-healthy').mtimeMs < 90000 ? 0 : 1)"]
CMD ["node", "dist/src/index.js"]
