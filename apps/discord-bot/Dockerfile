# Build context is the monorepo root (see infra/docker-compose.prod.yml),
# because pnpm workspace install needs every workspace package.json present.
FROM node:20-alpine AS base
RUN corepack enable
WORKDIR /repo

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
# Every workspace package.json, or --frozen-lockfile refuses to install.
COPY apps/backend/package.json apps/backend/package.json
COPY apps/panel/package.json apps/panel/package.json
COPY apps/discord-bot/package.json apps/discord-bot/package.json
COPY packages ./packages
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm --filter @neoxify/discord-bot build
# --prod deploy dereferences the workspace's pnpm-store symlinks into a
# self-contained directory with only production dependencies, so the runtime
# image needs neither pnpm nor the workspace layout.
RUN pnpm --filter @neoxify/discord-bot --prod deploy /out

# --- Runtime image -----------------------------------------------------
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S bot && adduser -S bot -G bot

COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./package.json
COPY --from=build /repo/apps/discord-bot/dist ./dist

USER bot

# No port: the bot dials out to Discord's gateway and never accepts inbound
# connections, so there is nothing to expose or reverse-proxy.
CMD ["node", "dist/index.js"]
