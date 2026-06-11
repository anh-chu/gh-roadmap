# Multi-stage build for the gh-roadmap monolith (Fastify API + Vite/React SPA, single process).
# Base is glibc (bookworm-slim), not Alpine, so better-sqlite3 compiles its native binding cleanly.
# Target arch is arm64 to match the Graviton (t4g) EC2 host.

FROM node:22-bookworm-slim AS builder
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@11.0.6 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY api ./api
COPY web ./web
COPY shared ./shared
RUN pnpm build && pnpm prune --prod

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    WEB_DIST=/app/web/dist \
    DB_PATH=/data/roadmap.db
WORKDIR /app

# Copy as the non-root `node` user (uid 1000) so nothing in /app is root-owned and the app can
# write its sidecar files (e.g. .runtime-port) without running privileged.
COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/api/dist ./api/dist
COPY --chown=node:node --from=builder /app/web/dist ./web/dist
COPY --chown=node:node --from=builder /app/package.json ./package.json
# Prompt templates are plain .md, not emitted by tsc — ship them next to the compiled ai.js
# (loadPrompt resolves ./prompts relative to api/dist/api/src/ai.js).
COPY --chown=node:node --from=builder /app/api/src/prompts ./api/dist/api/src/prompts

RUN mkdir -p /data && chown node:node /app /data
USER node
EXPOSE 3000

CMD ["node", "api/dist/api/src/server.js"]
